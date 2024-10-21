# UEFI のメモリマップとお片付け

前回で Ymir カーネルをメモリにロードできたため、早速 Ymir を実行...!
といきたいところですが、本チャプターでは Ymir の実行まではいきません。
その前に UEFI にいる間しかできないお片付けをします。
また、UEFI が提供するメモリマップを取得して観察してみます。
このメモリマップはのちほど Ymir で使うことになるのですが、それを差し引いても UEFI のメモリマップを理解しておくことは重要です。

## Table of Contents

<!-- toc -->

## ファイルシステムのお片付け

Ymir をロードするために UEFI の Simple File System Protocol を使いました。
ルートファイルを開き、Ymir の ELF ファイルを開き、ヘッダをメモリに読み込んだことを覚えているでしょうか。
使ったものは片付けるのが世の常です。お片付けをしましょう。

ELF ファイルを読み込んだのは (1) ELFヘッダのパースのため (2) Ymir のロードのため の2回です。
この内、(2)については勿論 Ymir の実行に必要なため、(1)のみを片付けます:

```zig
// -- surtr/boot.zig --

status = boot_service.freePool(header_buffer);
if (status != .Success) {
    log.err("Failed to free memory for kernel ELF header.", .{});
    return status;
}
```

ヘッダ用の領域は [AllocatePool()](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#id16) で確保したため、対応する [FreePool()](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#efi-boot-services-freepool) で解放します。

続いて、開いていた Ymir のELFファイルを閉じます。

```zig
status = kernel.close();
if (status != .Success) {
    log.err("Failed to close kernel file.", .{});
    return status;
}
```

これで開いているファイルが存在しなくなったため、ルートディレクトリを閉じてあげます:

```zig
status = root_dir.close();
if (status != .Success) {
    log.err("Failed to close filesystem volume.", .{});
    return status;
}
```

## メモリマップの取得

お片付けとは少し違いますが、UEFI が提供するメモリマップを取得します。
このメモリマップは、現在利用されている全てのメモリに関する情報を提供します。
Surtr においてカーネル用の領域として `AllocatePages()` や `AllocatePool()` で確保した領域も含まれます。
取得したマップは、のちほど Ymir に渡し、Ymir はアロケータを構築するために利用します。

### メモリマップの定義

`surtr/defs.zig` を新しく作成します。
このファイルは、Ymir と Surtr で共通して利用するデータ構造を定義するのに使います。
以下のようにメモリマップを定義します:

```zig
// -- surtr/defs.zig --

pub const MemoryMap = extern struct {
    /// Total buffer size prepared to store the memory map.
    buffer_size: usize,
    /// Memory descriptors.
    descriptors: [*]uefi.tables.MemoryDescriptor,
    /// Total memory map size.
    map_size: usize,
    /// Map key used to check if the memory map has been changed.
    map_key: usize,
    /// Size in bytes of each memory descriptor.
    descriptor_size: usize,
    /// UEFI memory descriptor version.
    descriptor_version: u32,
};
```

メモリマップの主要な要素は `MemoryDescriptor` の配列です。
**1つのディスクリプタは、1つの連続するメモリ領域を表現します**。
配列のサイズは `map_size / descriptor_size` です。

### `MemoryDescriptor` のイテレータ

ELF のセグメントヘッダをイテレートしたように、`MemoryDescriptor` もイテレート簡単にイテレートできると便利そうです。
`MemoryMap` の情報をもとに `MemoryDescriptor` のイテレートする構造体を定義します:

```zig
// -- surtr/defs.zig --

pub const MemoryDescriptorIterator = struct {
    const Self = @This();
    const Md = uefi.tables.MemoryDescriptor;

    descriptors: [*]Md,
    current: *Md,
    descriptor_size: usize,
    total_size: usize,

    pub fn new(map: MemoryMap) Self {
        return Self {
            .descriptors = map.descriptors,
            .current = @ptrCast(map.descriptors),
            .descriptor_size = map.descriptor_size,
            .total_size = map.map_size,
        };
    }

    pub fn next(self: *Self) ?*Md {
        if (@intFromPtr(self.current) >= @intFromPtr(self.descriptors) + self.total_size) {
            return null;
        }
        const md = self.current;
        self.current = @ptrFromInt(@intFromPtr(self.current) + self.descriptor_size);
        return md;
    }
};
```

`new()`では、イテレートに必要な3つの要素 `descriptors`, `descriptor_size`, `total_size` を記憶します。
また、現在の `MemoryDescriptor` を指すポインタ `current` を先頭に初期化します。

`next()` は、現在指している `MemoryDescriptor` を返し、イテレータを次の `MemoryDescriptor` に進めます。
先述したように、`MemoryDescriptor`は連続した配列であり、1つの要素のサイズは `descriptor_size` であるため、
`current` に `descriptor_size` を加算することで次の要素に進めます。
もしも次の要素が存在しない場合は `null` を返します。

### メモリマップの取得と表示

`surtr/boot.zig` にメモリマップを取得する関数を追加します:

```zig
// -- surtr/boot.zig --

const map_buffer_size = page_size * 4;
var map_buffer: [map_buffer_size]u8 = undefined;
var map = defs.MemoryMap{
    .buffer_size = map_buffer.len,
    .descriptors = @alignCast(@ptrCast(&map_buffer)),
    .map_key = 0,
    .map_size = map_buffer.len,
    .descriptor_size = 0,
    .descriptor_version = 0,
};
status = getMemoryMap(&map, boot_service);
```

実際にメモリマップを取得する関数 `getMemoryMap()` はこのあとすぐに実装します。
ここで取得するメモリマップは、あくまでもメモリマップの"コピー"です。
よって、もとのマップをコピーするためのバッファが必要となります。
バッファがどれだけ必要かは利用されているメモリブロックの個数に依存しますが、今回は固定で4ページ分のバッファを用意します[^1]。
これだけあればおそらく十分でしょう。
`getMemomryMap()` は、`MemoryMap` を引数にとった上で、その中身を埋めて返します。
引数として渡すマップには、用意したバッファのアドレスとサイズだけを指定すればOKです。

続いて、実際にメモリマップを取得する関数を実装します:

```zig
fn getMemoryMap(map: *defs.MemoryMap, boot_services: *uefi.tables.BootServices) uefi.Status {
    return boot_services.getMemoryMap(
        &map.map_size,
        map.descriptors,
        &map.map_key,
        &map.descriptor_size,
        &map.descriptor_version,
    );
}
```

UEFI の Runtime Services が提供する、メモリマップを取得するための [`GetMemoryMap()`](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#efi-boot-services-getmemorymap) の単なるラッパーです。

最後に、取得したメモリマップを表示します:

```zig
// -- surtr/boot.zig --

var map_iter = defs.MemoryDescriptorIterator.new(map);
while (true) {
    if (map_iter.next()) |md| {
        log.debug("  0x{X:0>16} - 0x{X:0>16} : {s}", .{
            md.physical_start,
            md.physical_start + md.number_of_pages * page_size,
            @tagName(md.type),
        });
    } else break;
}
```

実行すると、以下のようにメモリマップが表示されます。各メモリタイプの意味は[こちらのテーブル](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-type-usage-before-exitbootservices)を参照してください:

<details>
<summary>UEFI メモリマップの確認</summary>

```txt
[DEBUG] (surtr): Memory Map (Physical): Buf=0x1FE91FA0, MapSize=0x1770, DescSize=0x30
[DEBUG] (surtr):   0x0000000000000000 - 0x0000000000001000 : BootServicesCode
[DEBUG] (surtr):   0x0000000000001000 - 0x00000000000A0000 : ConventionalMemory
[DEBUG] (surtr):   0x0000000000100000 - 0x0000000000101000 : LoaderData
[DEBUG] (surtr):   0x0000000000101000 - 0x0000000000800000 : ConventionalMemory
[DEBUG] (surtr):   0x0000000000800000 - 0x0000000000808000 : ACPIMemoryNVS
[DEBUG] (surtr):   0x0000000000808000 - 0x000000000080B000 : ConventionalMemory
[DEBUG] (surtr):   0x000000000080B000 - 0x000000000080C000 : ACPIMemoryNVS
[DEBUG] (surtr):   0x000000000080C000 - 0x0000000000810000 : ConventionalMemory
[DEBUG] (surtr):   0x0000000000810000 - 0x0000000000900000 : ACPIMemoryNVS
[DEBUG] (surtr):   0x0000000000900000 - 0x0000000001780000 : BootServicesData
[DEBUG] (surtr):   0x0000000001780000 - 0x000000001BEF7000 : ConventionalMemory
[DEBUG] (surtr):   0x000000001BEF7000 - 0x000000001BF17000 : BootServicesData
[DEBUG] (surtr):   0x000000001BF17000 - 0x000000001E256000 : ConventionalMemory
[DEBUG] (surtr):   0x000000001E256000 - 0x000000001E25F000 : LoaderCode
[DEBUG] (surtr):   0x000000001E25F000 - 0x000000001E265000 : ConventionalMemory
[DEBUG] (surtr):   0x000000001E265000 - 0x000000001E4DA000 : BootServicesData
[DEBUG] (surtr):   0x000000001E4DA000 - 0x000000001E4DB000 : ConventionalMemory
[DEBUG] (surtr):   0x000000001E4DB000 - 0x000000001E989000 : BootServicesData
[DEBUG] (surtr):   0x000000001E989000 - 0x000000001EA3D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EA3D000 - 0x000000001EA6D000 : BootServicesData
[DEBUG] (surtr):   0x000000001EA6D000 - 0x000000001EB4E000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EB4E000 - 0x000000001EBBA000 : BootServicesData
[DEBUG] (surtr):   0x000000001EBBA000 - 0x000000001EBC3000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EBC3000 - 0x000000001EBC8000 : BootServicesData
[DEBUG] (surtr):   0x000000001EBC8000 - 0x000000001EC07000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC07000 - 0x000000001EC0A000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC0A000 - 0x000000001EC0D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC0D000 - 0x000000001EC14000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC14000 - 0x000000001EC26000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC26000 - 0x000000001EC27000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC27000 - 0x000000001EC2A000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC2A000 - 0x000000001EC2F000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC2F000 - 0x000000001EC3D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC3D000 - 0x000000001EC4C000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC4C000 - 0x000000001EC57000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC57000 - 0x000000001EC62000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC62000 - 0x000000001EC78000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EC78000 - 0x000000001EC81000 : BootServicesData
[DEBUG] (surtr):   0x000000001EC81000 - 0x000000001ECA5000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECA5000 - 0x000000001ECA8000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECA8000 - 0x000000001ECBC000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECBC000 - 0x000000001ECC3000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECC3000 - 0x000000001ECC9000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECC9000 - 0x000000001ECCC000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECCC000 - 0x000000001ECDA000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECDA000 - 0x000000001ECDB000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECDB000 - 0x000000001ECE6000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECE6000 - 0x000000001ECE8000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECE8000 - 0x000000001ECF5000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ECF5000 - 0x000000001ECFA000 : BootServicesData
[DEBUG] (surtr):   0x000000001ECFA000 - 0x000000001ED07000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED07000 - 0x000000001ED0A000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED0A000 - 0x000000001ED16000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED16000 - 0x000000001ED17000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED17000 - 0x000000001ED1A000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED1A000 - 0x000000001ED1C000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED1C000 - 0x000000001ED29000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED29000 - 0x000000001ED2C000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED2C000 - 0x000000001ED2D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED2D000 - 0x000000001ED30000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED30000 - 0x000000001ED39000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED39000 - 0x000000001ED3A000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED3A000 - 0x000000001ED3C000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED3C000 - 0x000000001ED3E000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED3E000 - 0x000000001ED4D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED4D000 - 0x000000001ED4F000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED4F000 - 0x000000001ED6C000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED6C000 - 0x000000001ED6D000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED6D000 - 0x000000001ED70000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED70000 - 0x000000001ED73000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED73000 - 0x000000001ED78000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED78000 - 0x000000001ED7B000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED7B000 - 0x000000001ED90000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED90000 - 0x000000001ED92000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED92000 - 0x000000001ED94000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED94000 - 0x000000001ED97000 : BootServicesData
[DEBUG] (surtr):   0x000000001ED97000 - 0x000000001ED9E000 : BootServicesCode
[DEBUG] (surtr):   0x000000001ED9E000 - 0x000000001EDA5000 : BootServicesData
[DEBUG] (surtr):   0x000000001EDA5000 - 0x000000001EDA9000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EDA9000 - 0x000000001EDAD000 : BootServicesData
[DEBUG] (surtr):   0x000000001EDAD000 - 0x000000001EDCC000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EDCC000 - 0x000000001EDCE000 : BootServicesData
[DEBUG] (surtr):   0x000000001EDCE000 - 0x000000001EDD9000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EDD9000 - 0x000000001EDDE000 : BootServicesData
[DEBUG] (surtr):   0x000000001EDDE000 - 0x000000001EDEF000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EDEF000 - 0x000000001EDF0000 : BootServicesData
[DEBUG] (surtr):   0x000000001EDF0000 - 0x000000001EDF8000 : BootServicesCode
[DEBUG] (surtr):   0x000000001EDF8000 - 0x000000001F000000 : BootServicesData
[DEBUG] (surtr):   0x000000001F000000 - 0x000000001F00B000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F00B000 - 0x000000001F010000 : BootServicesData
[DEBUG] (surtr):   0x000000001F010000 - 0x000000001F0D1000 : RuntimeServicesData
[DEBUG] (surtr):   0x000000001F0D1000 - 0x000000001F0EA000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F0EA000 - 0x000000001F0ED000 : BootServicesData
[DEBUG] (surtr):   0x000000001F0ED000 - 0x000000001F0F6000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F0F6000 - 0x000000001F0F8000 : BootServicesData
[DEBUG] (surtr):   0x000000001F0F8000 - 0x000000001F0F9000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F0F9000 - 0x000000001F0FB000 : BootServicesData
[DEBUG] (surtr):   0x000000001F0FB000 - 0x000000001F0FF000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F0FF000 - 0x000000001F101000 : BootServicesData
[DEBUG] (surtr):   0x000000001F101000 - 0x000000001F117000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F117000 - 0x000000001F118000 : BootServicesData
[DEBUG] (surtr):   0x000000001F118000 - 0x000000001F11A000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F11A000 - 0x000000001F12D000 : BootServicesData
[DEBUG] (surtr):   0x000000001F12D000 - 0x000000001F12F000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F12F000 - 0x000000001F52F000 : BootServicesData
[DEBUG] (surtr):   0x000000001F52F000 - 0x000000001F537000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F537000 - 0x000000001F53D000 : BootServicesData
[DEBUG] (surtr):   0x000000001F53D000 - 0x000000001F547000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F547000 - 0x000000001F548000 : BootServicesData
[DEBUG] (surtr):   0x000000001F548000 - 0x000000001F54D000 : BootServicesCode
[DEBUG] (surtr):   0x000000001F54D000 - 0x000000001F8ED000 : BootServicesData
[DEBUG] (surtr):   0x000000001F8ED000 - 0x000000001F9ED000 : RuntimeServicesData
[DEBUG] (surtr):   0x000000001F9ED000 - 0x000000001FAED000 : RuntimeServicesCode
[DEBUG] (surtr):   0x000000001FAED000 - 0x000000001FB6D000 : ReservedMemoryType
[DEBUG] (surtr):   0x000000001FB6D000 - 0x000000001FB7F000 : ACPIReclaimMemory
[DEBUG] (surtr):   0x000000001FB7F000 - 0x000000001FBFF000 : ACPIMemoryNVS
[DEBUG] (surtr):   0x000000001FBFF000 - 0x000000001FE00000 : BootServicesData
[DEBUG] (surtr):   0x000000001FE00000 - 0x000000001FE77000 : ConventionalMemory
[DEBUG] (surtr):   0x000000001FE77000 - 0x000000001FE97000 : BootServicesData
[DEBUG] (surtr):   0x000000001FE97000 - 0x000000001FECA000 : BootServicesCode
[DEBUG] (surtr):   0x000000001FECA000 - 0x000000001FEDB000 : BootServicesData
[DEBUG] (surtr):   0x000000001FEDB000 - 0x000000001FEF4000 : BootServicesCode
[DEBUG] (surtr):   0x000000001FEF4000 - 0x000000001FF78000 : RuntimeServicesData
[DEBUG] (surtr):   0x000000001FF78000 - 0x0000000020000000 : ACPIMemoryNVS
[DEBUG] (surtr):   0x00000000FEFFC000 - 0x00000000FF000000 : ReservedMemoryType
```

</details>

以上でメモリマップの取得は完了です。
しばしお茶でもしばきながら、表示されたメモリマップを眺めて、`AllocatePages()`で確保した領域はなんというメモリタイプになっているかなどを確認してみてください。

## Exit Boot Services

TODO

[^1]: ちゃんと実装したい場合には、少なめのサイズのバッファを用意して `getMemoryMap()` を呼び出し、
エラーが返ってきた場合にはバッファを拡張して再度呼び出すという方法が考えられます。