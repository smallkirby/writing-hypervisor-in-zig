<!-- i18n:skip -->
# Page Allocator

前チャプターまでは UEFI から提供されるデータ構造を Ymir のものに置き換えていきました。
ページテーブルもその1つであり、現在は UEFI が用意したページテーブルを使っています。
ページテーブルを Ymir 用に新しく作成したいのですが、その作業自体に Page Allocator が必要となります。

このチャプターでは、ページ割当てを司る Page Allocator を実装します。
Zig には「暗黙的なメモリ割当てが極めて少ない」という特徴があります。
`std` ライブラリでメモリ割当てを必要とする関数は全て引数に `Allocator` をとります。
逆に言うと、`Allocator` をとらない関数は動的なメモリ割当てを行いません。
このチャプターでは、Zig の要でもある `Allocator` インタフェース[^interface]をもつ Page Allocator を実装していきます。

> [!IMPORTANT]
>
> 本チャプターの最終コードは [`whiz-ymir-page_allocator`](https://github.com/smallkirby/ymir/tree/whiz-ymir-page_allocator) ブランチにあります。

## Table of Contents

<!-- toc -->

## Allocator インタフェース

まず Zig の `Allocator` を実装する手順を概観するため、スケルトンの実装をしましょう:

<!-- i18n:skip -->
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
そのため、この型は他のファイルから以下のようにしてアクセスできます:

<!-- i18n:skip -->
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
`allocate()` / `free()` / `resize()` の 3API を提供することです。
この3つさえ実装すれば、残りの細々としたユーティリティ関数は `Allocator` が提供してくれます。

## Bitmap

### Ymir が利用可能なメモリ

Ymir の `PageAllocator` では、利用できる(割当可能な)ページをビットマップで管理することにします。
「利用できるページ」をどうやって知るのかというと、UEFI から提供されるメモリマップを使います。
[カーネルの起動](../bootloader/jump_to_ymir.md) では、Surtr から Ymir に対してメモリマップを渡していました。
`PageAllocator` では初期化時にこのメモリマップを受取り、メモリを探査して利用可能なページをビットマップに記録していきます:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
pub fn init(self: *Self, map: MemoryMap) void {
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
メモリマップには、その [メモリの種類](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-type-usage-before-exitbootservices) も記録されています。
この内、Ymir では *Conventional Memory* と *Boot Services Code* の2つを OS(Ymir) が自由に利用可能な領域として扱います。

> [!NOTE]
>
> 本当は *Boot Services Data* も利用可能な領域です。
> しかし、この領域にはまだ Ymir が利用中のデータが入っています。
> そう、ページテーブルです。
> まだ Ymir はページテーブルを自前で用意せず UEFI が用意してくれたものを使いまわしているため、
> この領域は利用(上書き)してはいけません。
> のちのチャプターで自前のページテーブルを用意したあとで *Boot Services Data* を解放し Ymir が利用可能な領域にすることができますが、本シリーズでは扱いません。
> [オリジナルの Ymir](https://github.com/smallkirby/ymir) ではこの領域も利用可能な領域として扱っているため、気になる人はそちらを参照してください。

Memory Descriptor を受け取って、そのメモリが利用可能かどうかを返す関数を定義しておきます:

<!-- i18n:skip -->
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
Zig では任意のビット幅を持つ整数型を利用することができますが、
`[N]u1` のような配列を作っても一要素が 1byte になってしまいます。
よって、今回は `u64` 型の配列としてビットマップを実装していきます:

<!-- i18n:skip -->
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

### Phys-Virt 変換

`PageAllocator` はページ番号を使ってページを管理します。
ページ番号は、物理アドレスから計算できます:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
const FrameId = u64;
const bytes_per_frame = 4 * kib;

inline fn phys2frame(phys: Phys) FrameId {
    return phys / bytes_per_frame;
}

inline fn frame2phys(frame: FrameId) Phys {
    return frame * bytes_per_frame;
}
```

`FrameId` がページ番号です。
ページ番号は、物理アドレスの下位10bitを切り詰めることで得られます。

ページ番号を扱うということは、このアロケータは物理アドレスを扱うということです。
しかしながら、アロケータが返すアドレスは仮想アドレスでなければいけません。
よって、仮想アドレスと物理アドレスの変換をする必要があります。
今のところ UEFI から提供されたページテーブルはダイレクトマップであり、物理アドレスと仮想アドレスが等しいです。
しかし、次チャプターでメモリマップを再構築すると両者は等しくなくなります。
そのときに備えて、物理アドレスと仮想アドレスの変換をしてくれる関数を用意しておきましょう:

<!-- i18n:skip -->
```ymir/mem.zig
pub fn virt2phys(addr: anytype) Phys {
    return @intCast(addr);
}
pub fn phys2virt(addr: anytype) Virt {
    return @intCast(addr);
}
```

現在は引数をそのまま返すだけの関数ですが、メモリマップを再構築した暁には適切な変換をするようにします。

### ユーティリティ

定義したビットマップに対する操作をする関数を用意します:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
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

`Status` はビットマップの 1bit に対応し、そのビットが表現するページの割当て状態を表します。
`get()` はビットマップの指定したページ番号 (`FrameId`) の `Status` を取得します。
途中で登場する `bit_index` はビットマップの1単位である 64bit の中でのオフセットを表します。
0 ~ 63 の値を取るため、`u6` 型としています。
`set()` は逆にビットマップの指定したページ番号の `Status` を設定します。

1ページ単位ではなく複数ページの状態をまとめて変更するヘルパー関数も用意しておきます:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
fn markAllocated(self: *Self, frame: FrameId, num_frames: usize) void {
    for (0..num_frames) |i| {
        self.set(frame + i, .used);
    }
}

fn markNotUsed(self: *Self, frame: FrameId, num_frames: usize) void {
    for (0..num_frames) |i| {
        self.set(frame + i, .unused);
    }
}
```

### メモリマップの探索と初期化

ここまでで作成したビットマップを使い、メモリアロケータを初期化します。
`init()` においてメモリマップをひとつずつイテレートし、そのメモリ領域が Ymir が利用可能なものであればビットマップに記録します:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
frame_begin: FrameId = 1,
frame_end: FrameId,

pub fn init(self: *Self, map: MemoryMap) void {
    ...
    while (true) {
        const desc: *uefi.tables.MemoryDescriptor = desc_iter.next() orelse break;

        // Mark holes between regions as allocated (used).
        if (avail_end < desc.physical_start) {
            self.markAllocated(phys2frame(avail_end), desc.number_of_pages);
        }
        // Mark the region described by the descriptor as used or unused.
        const phys_end = desc.physical_start + desc.number_of_pages * page_size;
        if (isUsableMemory(desc)) {
            avail_end = phys_end;
            self.markNotUsed(phys2frame(desc.physical_start), desc.number_of_pages);
        } else {
            self.markAllocated(phys2frame(desc.physical_start), desc.number_of_pages);
        }

        self.frame_end = phys2frame(avail_end);
    }
}
```

`frame_begin` と `frame_end` は `PageAllocator` のメンバ変数であり、このアロケータが管理するページ番号の範囲を記録します。
後半の `if` ではメモリ領域が利用可能かどうかに応じて、ビットマップに確保済みまたは利用可能なページを記録します。

これで UEFI のメモリマップを探索し、割当て可能なページをビットマップに記録できました。

## allocate

ここからは `Allocator` が要求する vtable の各関数を実装していきます。
まずは指定されたサイズだけメモリを確保する `allocate()` です:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
const p2v = phys2virt;
const v2p = virt2phys;

fn allocate(ctx: *anyopaque, n: usize, _: u8, _: usize) ?[*]u8 {
    const self: *PageAllocator = @alignCast(@ptrCast(ctx));

    const num_frames = (n + page_size - 1) / page_size;
    var start_frame = self.frame_begin;

    while (true) {
        var i: usize = 0;
        while (i < num_frames) : (i += 1) {
            if (start_frame + i >= self.frame_end) return null;
            if (self.get(start_frame + i) == .used) break;
        }
        if (i == num_frames) {
            self.markAllocated(start_frame, num_frames);
            return @ptrFromInt(p2v(frame2phys(start_frame)));
        }

        start_frame += i + 1;
    }
}
```

| Argument | Description |
| --- | --- |
| 0: `ctx` | `Allocator.ptr`. `PageAllocator` インスタンスへのポインタ。 |
| 1: `n` | 確保するメモリのサイズ (in bytes) |
| 2: `_` | 要求するアラインメント |
| 3: `_` | 謎[^ret_addr] |

第0引数の `ctx` は `Allocator.ptr` へのポインタです。
`Allocator` の実体は任意の構造体に成り得るため `anyopaque` という型になっています。
ここでは受け取ったポインタを `*PageAllocator` 型にキャストして、`*Self` として使えるようにしています。

最初に要求されるアドレスをページ番号に変換したあと、ビットマップを探索して利用可能なページを探します。
領域は必ず連続して利用可能である必要があるため、連続して空いているページを探します。
利用可能な領域が見つかった場合、`markAllocated()` でそのページを確保済みにし、そのアドレスを返します。
見つからなかった場合には `null` を返します。

> [!NOTE]
>
> `allocate()` の第2引数は要求するアラインメントです。
> `0x30` を指定された場合、返す領域のポインタは `0x00`, `0x30`, `0x60`, ... で終わる必要があります。
> しかし、`Allocator` が想定するアラインメントの最大値はページサイズです[^align]。
> ページアロケータは原理上必ずページアラインされたアドレスしか返さないため、この引数は無視することができます。

## free

続いて、確保したメモリを解放する `free()` を実装します。
`free()` が受け取るメモリへのポインタは、`[]u8` になっています。
これは [Slice](https://ziglang.org/documentation/master/#Slices) 型といい、ポインタとサイズを持った fat pointer です。
このおかげで、**Zig のアロケータは解放を要求されたメモリアドレスとそのサイズを紐付ける必要がありません**。
代わりに利用者側がアドレスとサイズ (= スライス) を渡す責任を負います。
もし生のポインタを渡せるようになっていた場合、指定されたアドレスがどれだけのサイズで確保されたのかについてメタデータを保持する必要が出てきます (Cの `malloc()` などがそうですね)。
実装がかなり簡単になるので嬉しいですね:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
fn free(ctx: *anyopaque, slice: []u8, _: u8, _: usize) void {
    const self: *PageAllocator = @alignCast(@ptrCast(ctx));

    const num_frames = (slice.len + page_size - 1) / page_size;
    const start_frame_vaddr: Virt = @intFromPtr(slice.ptr) & ~page_mask;
    const start_frame = phys2frame(v2p(start_frame_vaddr));
    self.markNotUsed(start_frame, num_frames);
}
```

## resize

最後に、確保したメモリのサイズを変更する `resize()` です。
本シリーズでは、この関数は実装しません。
ユースケースとしてリサイズをしたいときがないので、問題なしです:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
fn resize(_: *anyopaque, _: []u8, _: u8, _: usize, _: usize) bool {
    @panic("PageAllocator does not support resizing");
}
```

ちゃんとした `resize()` も実装自体はそんなに難しくありません。
`free()` を呼んだ後に `allocate()` を呼ぶだけです。
実装したい方はしてみてください。

## ページ単位での確保

これで `Allocator` インタフェースの実装が終わりました。
もう `Allocator` を作成可能なのですが、もうひとつだけ追加で関数を実装しておきます。
`Allocator` は基本的にページ単位でのメモリ確保を想定していません[^page-alloc]。
しかし、OS ではページ単位でのメモリ確保をしたい場合が多くあります。
よって、ページ数を指定してメモリを確保できるような関数があると便利です。
また、ページサイズ以上のアラインを指定したい場合にも必要となります[^align]。

作成した関数は、`Allocator` を介して呼び出すことはできません。
しかしながら `Allocator` はあくまでもインタフェースであり、
その裏側にあるアロケータインスタンスに対して直接アクセスすることで `Allocator` が備えていない関数を呼び出すことは可能です。

それでは、ページ単位でのメモリ確保をする関数を実装します:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
pub fn allocPages(self: *PageAllocator, num_pages: usize, align_size: usize) ?[]u8 {
    const num_frames = num_pages;
    const align_frame = (align_size + page_size - 1) / page_size;
    var start_frame = align_frame;

    while (true) {
        var i: usize = 0;
        while (i < num_frames) : (i += 1) {
            if (start_frame + i >= self.frame_end) return null;
            if (self.get(start_frame + i) == .used) break;
        }
        if (i == num_frames) {
            self.markAllocated(start_frame, num_frames);
            const virt_addr: [*]u8 = @ptrFromInt(p2v(frame2phys(start_frame)));
            return virt_addr[0 .. num_pages * page_size];
        }

        start_frame += align_frame;
        if (start_frame + num_frames >= self.frame_end) return null;
    }
}
```

中身はほぼ `allocate()` と同じです。
引数はサイズをの代わりにページ数を受け取ります。
`align_size` にはページサイズ以上のアラインメントを指定することができ、空きページを探索する際にはこのアラインメントを考慮します。

## Allocator の作成

以上で準備が整いました。
Ymir で利用できる `Allocator` を作成しましょう:

<!-- i18n:skip -->
```ymir/mem/PageAllocator.zig
pub fn newUninit() Self {
    return Self{
        .frame_end = undefined,
        .bitmap = undefined,
    };
}
```

<!-- i18n:skip -->
```ymir/mem.zig
pub const PageAllocator = @import("mem/PageAllocator.zig");
pub var page_allocator_instance = PageAllocator.newUninit();
pub const page_allocator = Allocator{
    .ptr = &page_allocator_instance,
    .vtable = &PageAllocator.vtable,
};

pub fn initPageAllocator(map: MemoryMap) void {
    page_allocator_instance.init(map);
}
```

`page_allocator_instance` は `PageAllocator` の唯一のインスタンスです。
基本的にこちらのインスタンスは直接触ることはありません。
唯一使う必要があるのは、先ほどの `allocPages()` を呼び出す場合のみです。
というか、このインスタンスは直接触らせたくないので本当は `pub` 指定したくありません。
`PageAllocator` という型自体も同様です。
しかし、`Allocator.alignedAlloc()` がページサイズ以上のアラインを許容しないため致し方ありません[^align]。

肝心の `Allocator` は、`ptr` と `vtable` を指定してあげることで作成します。
`ptr` は `page_allocator_instance` インスタンスへのポインタです。
これにより先ほど実装した3つの関数だけでなく、`alloc()`, `create()`, `alignedAlloc()`, `allocSentinel()` など `Allocator` インタフェースが提供するさまざまな関数を利用できるようになります。

利用時には以下のようにして `Allocator` として利用します (内部実装を気にする必要がありません):

<!-- i18n:skip -->
```ymir/main.zig
mem.initPageAllocator(boot_info.memory_map);
log.info("Initialized page allocator", .{});
const page_allocator = ymir.mem.page_allocator;

const array = try page_allocator.alloc(u32, 4);
log.debug("Memory allocated @ {X:0>16}", .{@intFromPtr(array.ptr)});
page_allocator.free(array);
```

## まとめ

本チャプターでは UEFI から提供されたメモリマップをもとに利用可能なページを追跡する `PageAllocator` を実装しました。
メモリアロケータができたことで、いろいろなことができるようになります。
たとえばページテーブル用のページを確保できるようになったため、メモリマップを再構築できるようになります。
また、VT-x では vCPU ごとに VMCS 用のページを確保してあげる必要もあります。
今回実装した `PageAllocator` はページを確保する以外にも、汎用的な(小さいサイズを確保する)アロケータとしても使えます。
もちろん 8byte を確保しようとしても 4KiB ページを確保してしまうのでメモリ効率はよくありませんが...。
というわけで、次はより効率的に汎用用途で使えるアロケータを実装していきます。
と言いたいところですが、次のチャプターでは一旦ページテーブルの再構築をしてしまいましょう。
物理アドレスと仮想アドレスがストレートではなくなったあとで、再びアロケータを実装していくことにします。

[^interface]: 厳密には Zig には *interface* という概念はありません。
しかし、他の言語で言うところの *interface* と大体似たようなものなのでこう呼んでいます。
[^file-struct]: 厳密に言うと、今まで作成した全てのファイルも型(構造体のようなもの)として扱われています。
だからこそ、`ymir.bits.XXX()` のようなアクセスが可能になっています。
[^ret_addr]: この引数が何なのかは、誰も知りません。
[^align]: `Allocator` では、[ページサイズ以上のアラインは禁止されています](https://github.com/ziglang/zig/blob/a03ab9ee01129913af526a38b688313ccd83dca2/lib/std/mem/Allocator.zig#L218)。
[^page-alloc]: これはアロケータインスタンスがページ単位の確保をあまり想定していないということではなく、`Allocator` インタフェースのことです。
