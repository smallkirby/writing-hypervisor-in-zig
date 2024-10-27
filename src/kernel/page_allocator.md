# Page Allocator

このチャプターでは、ページ割当てを司る Page Allocator を実装します。
Zig には「暗黙的なメモリ割当てが極めて少ない」という特徴があります。
`std` ライブラリでメモリ割当てを必要とする関数は全て引数に `Allocator` をとります。
逆に言うと、`Allocator` をとらない関数は動的なメモリ割当てを行いません。
このチャプターでは、Zig の要でもある `Allocator` インタフェース[^interface]をもつ Page Allocator を実装していきます。

## Table of Contents

<!-- toc -->

## Allocator インタフェース

まず Zig の `Allocator` を実装する手順を概観するため、スケルトンの実装をしましょう:

```ymir/mem/PageAllocator.zig
const Allocator = std.mem.Allocator;
const Self = @This();
const PageAllocator = Self;

pub const vtable = Allocator.VTable{
    .alloc = allocate,
    .free = free,
    .resize = resize,
};

fn allocate(ctx: *anyopaque, _: usize, _: u8, _: usize) ?[*]u8 { @panic("unimplemented"); }
fn free(ctx: *anyopaque, _: []u8, _: u8, _: usize) void { }
fn resize(ctx: *anyopaque, _: []u8, _: u8, _: usize, _: usize) bool { @panic("unimplemented"); }
```

`PageAllocator.zig` は今までのファイルとは少し異なり、**このファイル自体を構造体(型)として扱います**[^file-struct]。
そのため、この型は他のファイルから以下のようにしてアクセスすることができます:

```zig
const PageAllocator = @import("mem/PageAllocator.zig");
// 以下と同じ
const PageAllocator = @import("mem/PageAllocator.zig").PageAllocator; // <= 冗長
```

`Self` と `PageAllocator` は、`PageAllocator.zig` 自身を指す型のエイリアスです。
このファイル自体が構造体であるため、`vtable` はこの構造体の定数フィールドになります
(定数ではない通常のメンバ変数の定義もすぐに出てきます)。

本題の [`Allocator`](https://github.com/ziglang/zig/blob/6a364b4a5e71b971b753d2b62c7708ae1e76d707/lib/std/mem/Allocator.zig#L1) ですが、
この型は `ptr` と `vtable` という2つのメンバ変数を持ちます。
`ptr` は実際のアロケータインスタンスへのポインタであり、`vtable` はアロケータが持つべき[関数ポインタのテーブル](https://github.com/ziglang/zig/blob/6a364b4a5e71b971b753d2b62c7708ae1e76d707/lib/std/mem/Allocator.zig#L17-L54)です。
[Zig の標準のアロケータたち](https://zig.guide/standard-library/allocators/) は、この `Allocator` を返すメソッドを持っています。
アロケータを利用する側は、**そのアロケータの内部実装に関わらず `Allocator` として扱うことができる** というメリットがあります。

`vtable` は3つの関数を要求します。
各関数の役割はおそらく名前から明らかだと思いますが、それぞれメモリの確保・解放・再確保をします。
`Allocator` 経由で呼ばれたこれらの関数は、第1引数 `ctx` に `Allocator.ptr` が渡されます。
これはアロケータインスタンスであるため、共通の `Allocator` 経由で呼ばれても各アロケータの内部実装を呼び出すことができます。
つまりここでやるべきことは、`PageAllocator.zig` にページアロケータの内部実装を定義した上で、
`allocater()` / `free()` / `resize()` の 3API を提供することです。
この3つさえ実装すれば、残りの細々としたユーティリティ関数は `Allocator` が提供してくれます。

## Bitmap

### Ymir が利用可能なメモリ

Ymir の `PageAllocator` では、利用できる(割当可能な)ページをビットマップで管理することにします。
「利用できるページ」をどうやって知るのかというと、UEFI から提供されるメモリマップを使います。
[カーネルの起動](../bootloader/jump_to_ymir.md) では、Surtr から Ymir に対してメモリマップを渡していました。
`PageAllocator` では初期化時にこのメモリマップを受取り、メモリを探査して利用可能なページをビットマップに記録していきます:

```ymir/mem/PageAllocator.zig
pub fn init(self: *Self, map_: MemoryMap) void {
    var avail_end: Phys = 0;
    var desc_iter = MemoryDescriptorIterator.new(map);

    while (true) {
        const desc: *uefi.tables.MemoryDescriptor = desc_iter.next() orelse break;
        ...
    }
}
```

`MemoryDescriptorIterator` は [メモリマップとお片付け](../bootloader/cleanup_memmap.md) で実装したものであり、
メモリマップに対するイテレータを提供します。
このイテレータを使ってメモリマップを順に取り出していきます。
メモリマップには、その[メモリの種類](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-type-usage-before-exitbootservices)　も記録されています。
この内、Ymir では *Conventional Memory* と *Boot Services Code* の2つを OS(Ymir) が自由に利用可能な領域として扱います。

> [!NOTE] 本当はまだある利用可能領域
> 本当は *Boot Services Data* も利用可能な領域です。
> しかし、この領域にはまだ Ymir が利用中のデータが入っています。
> そう、ページテーブルです。
> まだ Ymir はページテーブルを自前で用意せず UEFI が用意してくれたものを使いまわしているため、
> この領域は利用(上書き)してはいけません。
> のちのチャプターで自前のページテーブルを用意したあとで *Boot Services Data* を解放し Ymir が利用可能な領域にすることができますが、本シリーズでは扱いません。
> [オリジナルの Ymir](https://github.com/smallkirby/ymir) ではこの領域も利用可能な領域として扱っているため、気になる人はそちらを参照してください。

Memory Descriptor を受け取って、そのメモリが利用可能かどうかを返す関数を定義しておきます:

```ymir/mem/PageAllocator.zig
inline fn isUsableMemory(descriptor: *uefi.tables.MemoryDescriptor) bool {
    return switch (descriptor.type) {
        .ConventionalMemory,
        .BootServicesCode,
        => true,
        else => false,
    };
}
```

### 管理できるメモリサイズ

`PageAllocator` が使うビットマップは、1ビットを1ページに対応させます。
Zig では整数型を任意のビット幅で持たせることもできますが、
`[N]u1` のような配列を作っても一要素が 1byte になってしまいます。
よって、今回は `u64` 型の配列としてビットマップを実装していきます:

```ymir/mem/PageAllocator.zig
/// Maximum physical memory size in bytes that can be managed by this allocator.
const max_physical_size = 128 * gib;
/// Maximum page frame count.
const frame_count = max_physical_size / 4096; // 32Mi frames

/// Single unit of bitmap line.
const MapLineType = u64;
/// Bits per map line.
const bits_per_mapline = @sizeOf(MapLineType) * 8; // 64
/// Number of map lines.
const num_maplines = frame_count / bits_per_mapline; // 512Ki lines
/// Bitmap type.
const BitMap = [num_maplines]MapLineType;
```

ビットマップのサイズは固定サイズにします。
そのため、ビットマップのサイズがそのまま管理できるメモリサイズの上限になります。
今回は 128GiB にしました。
ページ数換算で 128GiB / 4KiB = 32Mi ページです (`frame_count`)。
まあおそらく十分なのではないかと思います。
このページ数をもとにビットマップのサイズを計算した結果が `num_maplines` です。
`num_maplines` が 512Ki なので、ビットマップのサイズは \\( 512\text{Ki} \times 8 = 4\text{MiB} \\) になります。
ビットマップだけで 4MiB 使うのは少し癪ですが、実装が楽なので受け入れることにします。
まぁそもそも Ymir はほとんどメモリを使わないので問題なしです。

### ユーティリティ

TODO

```ymir/mem/PageAllocator.zig
const FrameId = u64;

const Status = enum(u1) {
    /// Page frame is in use.
    used = 0,
    /// Page frame is unused.
    unused = 1,

    pub inline fn from(boolean: bool) Status {
        return if (boolean) .used else .unused;
    }
};

fn get(self: *Self, frame: FrameId) Status {
    const line_index = frame / bits_per_mapline;
    const bit_index: u6 = @truncate(frame % bits_per_mapline);
    return Status.from(self.bitmap[line_index] & bits.tobit(MapLineType, bit_index) != 0);
}

fn set(self: *Self, frame: FrameId, status: Status) void {
    const line_index = frame / bits_per_mapline;
    const bit_index: u6 = @truncate(frame % bits_per_mapline);
    switch (status) {
        .used => self.bitmap[line_index] |= bits.tobit(MapLineType, bit_index),
        .unused => self.bitmap[line_index] &= ~bits.tobit(MapLineType, bit_index),
    }
}
```

[^interface]: 厳密には Zig には *interface* という概念はありません。
しかし、他の言語で言うところの *interface* と大体似たようなものなのでこう呼んでいます。
[^file-struct]: 厳密に言うと、今まで作成した全てのファイルも型(構造体のようなもの)として扱われています。
だからこそ、`ymir.bits.XXX()` のようなアクセスが可能になっています。
