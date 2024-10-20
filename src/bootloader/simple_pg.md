# 簡易版ページテーブル

前回で Ymir の ELF イメージをファイルかリードできるようになりました。
本当はそのままカーネルをロードしたいところでしたが、
そのためにはページテーブルを操作して ELF が要求する仮想アドレスをマップする必要があります。
ブートローダである Surtr がページテーブルを操作するのはその目的のためだけのため、
本チャプターでは必要最低限なページテーブルの操作を実装していきます。

## Table of Contents

<!-- toc -->

## arch ディレクトリの作成

ページテーブルの構造を始めとして、ページテーブルはアーキテクチャに大きく依存します。
本シリーズでは x64 以外をサポートしませんが、それでもアーキテクチャ依存のコードは階層を分けて書いていくことにします。

`arch` ディレクトリの中に `x86` ディレクトリを作成し、以下のような構造にします:

```sh
> tree ./surtr
./surtr
├── arch
│   └── x86
│       └── arch.zig
├── arch.zig
├── boot.zig
└── log.zig
```

- `arch.zig`: `boot.zig`から直接利用するファイル。
できる限りアーキ依存の概念を隠蔽できるようなAPIを提供し、`arch/`以下の不必要なAPIは参照できないようにします。
- `arch/x86/arch.zig`: x64 固有のAPIを export するルートファイル。

`/arch.zig` では以下のようにターゲットとなるアーキテクチャに応じて `arch` 以下のコードを export します:

```zig
// -- surtr/arch.zig --

const builtin = @import("builtin");
pub usingnamespace switch (builtin.target.cpu.arch) {
    .x86_64 => @import("arch/x86/arch.zig"),
    else => @compileError("Unsupported architecture."),
};
```

`builtin.target.cpu.arch` は `build.zig`の`cpu_arch`で指定したターゲットアーキテクチャです。
今回は `x86_64` で固定ですが、他のアーキにも対応するようにした場合ターゲットに応じて変化します。
コンパイル時に決定する値であるため、この`switch`文もコンパイル時に評価され、対応するアーキのルートファイルが export されます。

<div class="warning">
usingnamespace

[usingnamespace](https://ziglang.org/documentation/master/#usingnamespace) は、指定した構造体のフィールド全てを現在のスコープに持ってきてくれる機能です。
今回の場合、単純に `@import("arch/x86/arch.zig")` すると以下のように利用側では一段余計なフィールドを指定する必要があります:

```zig
// -- surtr/arch.zig --
pub const impl = @import("arch/x86/arch.zig");
// -- surtr/boot.zig --
const arch = @import("arch.zig");
arch.impl.someFunction();
```

`usingnamespace` を使うことで、この余計な一段階を省くことができるようになります:

```zig
// -- surtr/arch.zig --
pub usingnamespace @import("arch/x86/arch.zig");
// -- surtr/boot.zig --
const arch = @import("arch.zig");
arch.someFunction();
```

やや黒魔術的な見た目な機能ですが、`usingnamespace` を使って構造体内のフィールドを現在のファイルのトップレベルスコープに import するようなことはできないため安心してください:

```zig
usingnamespace @import("some.zig"); // someFunction() が定義されているファイル
someFunction(); // このようなことはできない
```

</div>

`arch/x86/arch.zig` はアーキ依存のコードに置いて `arch` 以外から利用したいファイルを定義します。
今回はページテーブルを実装したいため、 `arch/x86/page.zig` を作成したあと、
`arch/x86/arch.zig` から `page.zig` を export します。

```zig
// -- surtr/arch/x86/arch.zig --

pub const page = @import("page.zig");
```

これで `boot.zig` から x64 のページングに関する機能を利用できるようになりました。

## ページテーブルエントリ

ここから、ページテーブルの操作をできるようにしていきます。
そもそも、UEFI から Surtr に制御が移った時点で既に UEFI が 64bit モードに移行してくれており、
初期用のページテーブルを構築してくれています。
[gef](https://github.com/bata24/gef) の `vmmap` コマンドを使ってメモリマップを確認してみましょう。
`build.zig` で QEMU の起動コマンドとして `-s` を指定しているため、
ポート `1234` で GDB サーバにアタッチできます。
現在 Surtr は `main()` の最後に無限ループをするようになっているため、その間にGDBでアタッチします:

<details>
<summary>メモリマップの確認</summary>

```sh
gef> target remote:1234
gef> vmmap
--------------------------------------- Memory map ---------------------------------------
Virtual address start-end              Physical address start-end             Total size   Page size   Count  Flags
0x0000000000000000-0x0000000000200000  0x0000000000000000-0x0000000000200000  0x200000     0x200000    1      [RWX KERN ACCESSED DIRTY]
0x0000000000200000-0x0000000000800000  0x0000000000200000-0x0000000000800000  0x600000     0x200000    3      [RWX KERN ACCESSED]
0x0000000000800000-0x0000000000a00000  0x0000000000800000-0x0000000000a00000  0x200000     0x200000    1      [RWX KERN ACCESSED DIRTY]
0x0000000000a00000-0x000000001be00000  0x0000000000a00000-0x000000001be00000  0x1b400000   0x200000    218    [RWX KERN ACCESSED]
0x000000001be00000-0x000000001c000000  0x000000001be00000-0x000000001c000000  0x200000     0x200000    1      [RWX KERN ACCESSED DIRTY]
0x000000001c000000-0x000000001e200000  0x000000001c000000-0x000000001e200000  0x2200000    0x200000    17     [RWX KERN ACCESSED]
0x000000001e200000-0x000000001ee00000  0x000000001e200000-0x000000001ee00000  0xc00000     0x200000    6      [RWX KERN ACCESSED DIRTY]
0x000000001ee00000-0x000000001f000000  0x000000001ee00000-0x000000001f000000  0x200000     0x200000    1      [R-X KERN ACCESSED DIRTY]
0x000000001f000000-0x000000001fa00000  0x000000001f000000-0x000000001fa00000  0xa00000     0x200000    5      [RWX KERN ACCESSED DIRTY]
0x000000001fa00000-0x000000001fac6000  0x000000001fa00000-0x000000001fac6000  0xc6000      0x1000      198    [RWX KERN ACCESSED DIRTY]
0x000000001fac6000-0x000000001fac7000  0x000000001fac6000-0x000000001fac7000  0x1000       0x1000      1      [RW- KERN ACCESSED DIRTY]
0x000000001fac7000-0x000000001fac8000  0x000000001fac7000-0x000000001fac8000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001fac8000-0x000000001faca000  0x000000001fac8000-0x000000001faca000  0x2000       0x1000      2      [RW- KERN ACCESSED DIRTY]
0x000000001faca000-0x000000001facb000  0x000000001faca000-0x000000001facb000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001facb000-0x000000001facd000  0x000000001facb000-0x000000001facd000  0x2000       0x1000      2      [RW- KERN ACCESSED DIRTY]
0x000000001facd000-0x000000001facf000  0x000000001facd000-0x000000001facf000  0x2000       0x1000      2      [R-X KERN ACCESSED DIRTY]
0x000000001facf000-0x000000001fad1000  0x000000001facf000-0x000000001fad1000  0x2000       0x1000      2      [RW- KERN ACCESSED DIRTY]
0x000000001fad1000-0x000000001fad2000  0x000000001fad1000-0x000000001fad2000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001fad2000-0x000000001fad4000  0x000000001fad2000-0x000000001fad4000  0x2000       0x1000      2      [RW- KERN ACCESSED DIRTY]
0x000000001fad4000-0x000000001fadb000  0x000000001fad4000-0x000000001fadb000  0x7000       0x1000      7      [R-X KERN ACCESSED DIRTY]
0x000000001fadb000-0x000000001fade000  0x000000001fadb000-0x000000001fade000  0x3000       0x1000      3      [RW- KERN ACCESSED DIRTY]
0x000000001fade000-0x000000001fadf000  0x000000001fade000-0x000000001fadf000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001fadf000-0x000000001fae2000  0x000000001fadf000-0x000000001fae2000  0x3000       0x1000      3      [RW- KERN ACCESSED DIRTY]
0x000000001fae2000-0x000000001fae3000  0x000000001fae2000-0x000000001fae3000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001fae3000-0x000000001fae6000  0x000000001fae3000-0x000000001fae6000  0x3000       0x1000      3      [RW- KERN ACCESSED DIRTY]
0x000000001fae6000-0x000000001fae7000  0x000000001fae6000-0x000000001fae7000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001fae7000-0x000000001faea000  0x000000001fae7000-0x000000001faea000  0x3000       0x1000      3      [RW- KERN ACCESSED DIRTY]
0x000000001faea000-0x000000001faeb000  0x000000001faea000-0x000000001faeb000  0x1000       0x1000      1      [R-X KERN ACCESSED DIRTY]
0x000000001faeb000-0x000000001faed000  0x000000001faeb000-0x000000001faed000  0x2000       0x1000      2      [RW- KERN ACCESSED DIRTY]
0x000000001faed000-0x000000001fc00000  0x000000001faed000-0x000000001fc00000  0x113000     0x1000      275    [RWX KERN ACCESSED DIRTY]
0x000000001fc00000-0x000000001fe00000  0x000000001fc00000-0x000000001fe00000  0x200000     0x200000    1      [R-X KERN ACCESSED DIRTY]
0x000000001fe00000-0x0000000020000000  0x000000001fe00000-0x0000000020000000  0x200000     0x1000      512    [RWX KERN ACCESSED DIRTY]
0x0000000020000000-0x0000000040000000  0x0000000020000000-0x0000000040000000  0x20000000   0x200000    256    [RWX KERN ACCESSED]
0x0000000040000000-0x0000000080000000  0x0000000040000000-0x0000000080000000  0x40000000   0x40000000  1      [RWX KERN ACCESSED]
```

</details>

UEFI が用意してくれたページテーブルは仮想アドレスと物理アドレスをストレートにマップしています。
本格的なページテーブルの設定は Ymir でやるとして、Surtr では簡易的なページング設定だけをします。
本シリーズでは、4-level paging を採用します。
4-level paging における各レベルのページテーブルエントリは以下の構造をしています:

![Formats of CR3 and Paging-Structure Entries with 4-Level Paging](../assets/sdm/paging-structure-entries.png)
*Formats of CR3 and Paging-Structure Entries with 4-Level Paging. SDM Vol.3A 4.5.5*

4種類のエントリがあり、Intel ではそれぞれ **PML4E**, **PDPTE**, **PDE**, **PTE** と呼ばれています。
この呼び方はソフトウェアによって異なり、Linux では PGD, PUD, PMD, PTE と呼ばれています。
あまり名前が直感的でないため、本シリーズでは **Lv4**, **Lv3**, **Lv2**, **Lv1** と呼ぶことにします。

まずは4つのエントリそれぞれを表す構造体を定義していきます。
上の画像から分かるとおり、4つのエントリはそれも同じような構造を持っています[^1]。
そこで、以下のように `EntryBase()` という関数を定義し、それを使って4つのエントリを定義します:

```zig
// -- surtr/arch/x86/page.zig --

const TableLevel = enum { lv4, lv3, lv2, lv1 };

fn EntryBase(table_level: TableLevel) type {
    return packed struct(u64) {
        const Self = @This();
        const level = table_level;

        /// Present.
        present: bool = true,
        /// Read/Write.
        /// If set to false, wirte access is not allowed to the region.
        rw: bool,
        /// User/Supervisor.
        /// If set to false, user-mode access is not allowed to the region.
        us: bool,
        /// Page-level writh-through.
        /// Indirectly determines the memory type used to access the page or page table.
        pwt: bool = false,
        /// Page-level cache disable.
        /// Indirectly determines the memory type used to access the page or page table.
        pcd: bool = false,
        /// Accessed.
        /// Indicates wheter this entry has been used for translation.
        accessed: bool = false,
        /// Dirty bit.
        /// Indicates wheter software has written to the 2MiB page.
        /// Ignored when this entry references a page table.
        dirty: bool = false,
        /// Page Size.
        /// If set to true, the entry maps a page.
        /// If set to false, the entry references a page table.
        ps: bool,
        /// Ignored when CR4.PGE != 1.
        /// Ignored when this entry references a page table.
        /// Ignored for level-4 entries.
        global: bool = true,
        /// Ignored
        _ignored1: u2 = 0,
        /// Ignored except for HLAT paging.
        restart: bool = false,
        /// When the entry maps a page, physical address of the page.
        /// When the entry references a page table, 4KB aligned address of the page table.
        phys: u51,
        /// Execute Disable.
        xd: bool = false,
    };
}

const Lv4Entry = EntryBase(.lv4);
const Lv3Entry = EntryBase(.lv3);
const Lv2Entry = EntryBase(.lv2);
const Lv1Entry = EntryBase(.lv1);
```

Zig では関数が型を返すことができ、C++ でいうところのテンプレートに近いようなものを実現できます。
`EntryBase()` は `TableLevel` というエントリのレベルに相当する `enum` をとり、
そのレベルに応じたテーブルエントリの構造体を返す関数です。
引数にとった値は、返される構造体において定数として利用できます。
また、`packed struct(u64)` と指定することで、フィールドの合計サイズが 64bit になることを保証しています[^2]。

最後に、この `EntryBase()` を各 `LvXEntry` に対して呼び出すことで4つのテーブルエントリ型を定義しています。
C++ でいうところのテンプレートのインスタンス化のようなものです。
もちろんコンパイル時に決定されるため、ランタイムオーバーヘッドはありません。

この構造体に、エントリが指し示す1レベル下のページテーブルの物理アドレス、またはページの物理アドレスを取得するための関数を追加します:

```zig
// -- surtr/arch/x86/page.zig --

pub const Phys = u64;
pub const Virt = u64;

pub inline fn address(self: Self) Phys {
    return @as(u64, @intCast(self.phys)) << 12;
}
```

`Phys` と `Virt` は物理アドレスと仮想アドレスを表す型です。
ページング操作をする関数では物理アドレスと仮想アドレスを取り違えてしまうミスをしてしまいがち[^3]なため、
それを防ぐために要求するアドレスが物理アドレスと仮想アドレスかのどちらなのかを明示します[^4]。
`address()` 関数は、自身の `phys` をシフトして物理アドレスに変換するだけのヘルパー関数です。
返される物理アドレスは、エントリがページをマップする(`.ps==true`)であるならばマップするページの物理アドレスです。
ページテーブルを参照する(`.ps==false`)場合には、参照するページテーブルの物理アドレスになります。

続いて、ページテーブルエントリを作成する関数を定義します。
ページをマップするエントリを作成する場合には簡単です:

```zig
// -- surtr/arch/x86/page.zig --

pub fn newMapPage(phys: Phys, present: bool) Self {
    if (level == .lv4) @compileError("Lv4 entry cannot map a page");
    return Self{
        .present = present,
        .rw = true,
        .us = false,
        .ps = true,
        .phys = @truncate(phys >> 12),
    };
}
```

ページをマップするため `.ps` を `true` に設定し、マップするページの物理アドレスを設定します。
なお、Surtr/Ymir では 512GiB ページはサポートしないため、
もしも `Lv4Entry` (つまり `level == .lv4`) に対してこの関数を呼び出そうとした場合にはコンパイルエラーとします。

同様に、ページテーブルを参照するエントリを作成する関数も定義します:
この場合の引数は物理ページのアドレスではなく、自分よりも1レベルだけ低いエントリへのポインタにします。
そのためには、「自分よりも1レベル低いエントリの型」を定義してあげる必要があります。
`BaseType()`が返す構造体に以下の定数を持たせましょう:

```zig
// -- surtr/arch/x86/page.zig --

const LowerType = switch (level) {
    .lv4 => Lv3Entry,
    .lv3 => Lv2Entry,
    .lv2 => Lv1Entry,
    .lv1 => struct {},
};
```

自身が`Lv4Entry`ならば `LoterType` は `Lv3Entry` になります。
`Lv1Entry` よりも下のエントリは存在しないため、`Lv1Entry` の場合は空の構造体を返します。
これを用いると、ページテーブルを参照するエントリを作成する関数は以下のようになります:

```zig
// -- surtr/arch/x86/page.zig --

pub fn newMapTable(table: [*]LowerType, present: bool) Self {
    if (level == .lv1) @compileError("Lv1 entry cannot reference a page table");
    return Self{
        .present = present,
        .rw = true,
        .us = false,
        .ps = false,
        .phys = @truncate(@intFromPtr(table) >> 12),
    };
}
```

`table` はこのエントリが指すページテーブルへのポインタです。
先ほどとは対象的に、自身が `Lv1Entry` である場合にはコンパイルエラーとします。

## 4KiB ページのマップ

テーブルエントリの定義ができたので、実際にページをマップする関数を実装します。
Surtr では、4KiB ページのみをサポートすることにします。

ページウォークは以下の図[^5]のように CR3 に入っている Lv4 テーブルから始まります。
仮想アドレスの `[47:39]` ビット目が Lv4 テーブルにおけるインデックスです。
このインデックスから Lv4 エントリを取得すると、その中に Lv3 テーブルへのポインタが入っています。
これを繰り返すことで、4KiB ページをマップする Lv1 エントリにたどり着きます。

![Linear-Address Translation to a 4-KByte Page Using 4-Level Paging](../assets/sdm/address-translation-4level.png)
*Linear-Address Translation to a 4-KByte Page Using 4-Level Paging. SDM Vol.3A 4.5.4*

まずは各レベルのページテーブルを取得する関数です:

```zig
// -- surtr/arch/x86/page.zig --

const page_mask_4k = 0xFFF;
const num_table_entries: usize = 512;

fn getTable(T: type, addr: Phys) []T {
    const ptr: [*]T = @ptrFromInt(addr & ~page_mask_4k);
    return ptr[0..num_table_entries];
}
fn getLv4Table(cr3: Phys) []Lv4Entry {
    return getTable(Lv4Entry, cr3);
}
fn getLv3Table(lv3_paddr: Phys) []Lv3Entry {
    return getTable(Lv3Entry, lv3_paddr);
}
fn getLv2Table(lv2_paddr: Phys) []Lv2Entry {
    return getTable(Lv2Entry, lv2_paddr);
}
fn getLv1Table(lv1_paddr: Phys) []Lv1Entry {
    return getTable(Lv1Entry, lv1_paddr);
}
```

`getTable()` が内部実装であり、取得したいページテーブルエントリの型と物理アドレスを受け取ります。
ページテーブルは必ず 4KiB アラインメントされているため、下位12ビットをマスクしてページテーブルの先頭アドレスを取得します。
そうして計算したアドレスから 256 個のエントリを持つスライスとしてテーブルを返します。
残りの4つの関数は、それぞれのレベルのページテーブルを取得するためのヘルパー関数です。

続いて、指定された仮想アドレスに対応するページテーブルエントリを取得する関数を実装します。
この関数は仮想アドレスとページテーブルの物理アドレスを受取ります:

```zig
// -- surtr/arch/x86/page.zig --

fn getEntry(T: type, vaddr: Virt, paddr: Phys) *T {
    const table = getTable(T, paddr);
    const shift = switch (T) {
        Lv4Entry => 39,
        Lv3Entry => 30,
        Lv2Entry => 21,
        Lv1Entry => 12,
        else => @compileError("Unsupported type"),
    };
    return &table[(vaddr >> shift) & 0x1FFF];
}

fn getLv4Entry(addr: Virt, cr3: Phys) *Lv4Entry {
    return getEntry(Lv4Entry, addr, cr3);
}
fn getLv3Entry(addr: Virt, lv3tbl_paddr: Phys) *Lv3Entry {
    return getEntry(Lv3Entry, addr, lv3tbl_paddr);
}
fn getLv2Entry(addr: Virt, lv2tbl_paddr: Phys) *Lv2Entry {
    return getEntry(Lv2Entry, addr, lv2tbl_paddr);
}
fn getLv1Entry(addr: Virt, lv1tbl_paddr: Phys) *Lv1Entry {
    return getEntry(Lv1Entry, addr, lv1tbl_paddr);
}
```

`getEntry()` が内部実装で、最初に先程の `getTable()` を呼んでページテーブルをスライスとして取得します。
その後、先程の図に従って仮想アドレスからエントリのインデックスを計算し、テーブルから該当するエントリを取得して返します。
`getTable()` と同様に、残りの4つの関数は引数 `T` を具体化したヘルパー関数になっています。

仮想アドレスからページテーブルエントリを取得する準備ができました。
4KiB ページをマップする関数が以下です:

```zig
// -- surtr/arch/x86/page.zig --

pub const PageAttribute = enum {
    /// RO
    read_only,
    /// RW
    read_write,
    /// RX
    executable,
};

pub fn map4kTo(virt: Virt, phys: Phys, attr: PageAttribute, bs: *BootServices) PageError!void {
    const rw = switch (attr) {
        .read_only, .executable => false,
        .read_write => true,
    };

    const lv4ent = getLv4Entry(virt, am.readCr3());
    if (!lv4ent.present) try allocateNewTable(Lv4Entry, lv4ent, bs);

    const lv3ent = getLv3Entry(virt, lv4ent.address());
    if (!lv3ent.present) try allocateNewTable(Lv3Entry, lv3ent, bs);

    const lv2ent = getLv2Entry(virt, lv3ent.address());
    if (!lv2ent.present) try allocateNewTable(Lv2Entry, lv2ent, bs);

    const lv1ent = getLv1Entry(virt, lv2ent.address());
    if (lv1ent.present) return PageError.AlreadyMapped;
    var new_lv1ent = Lv1Entry.newMapPage(phys, true);

    new_lv1ent.rw = rw;
    lv1ent.* = new_lv1ent;
    // No need to flush TLB because the page was not present before.
}
```

| Argument | Description |
| --- | --- |
| `virt` | マップする仮想アドレス。 |
| `phys` | マップする物理アドレス。 |
| `attr` | マップするページの属性。 |
| `bs` | UEFI Boot Services。新たに作成するページテーブル用のメモリ確保のために使います。 |

先程の図で見たように、CR3 からスタートして Lv1 エントリまでページウォークをします。
その過程でページテーブルが存在しない、つまり `lvNent.present == false` である場合には `allocateNewTable()` で新しいページテーブルを作成します。
なお、この関数では対象の仮想アドレスが既にマップされている場合は想定していないため、以下の挙動をします:

- 仮想アドレスが既に 4KiB ページにマップされている場合: `AlreadyMapped` エラーを返す。
- 仮想アドレスが既に 2MiB 以上のページにマップされている場合: 既存のマップを上書きする。

Lv1 にまでたどり着いたら、事前に定義した `newMapPage()` を使って指定された物理ページにマップします。
その際、ページの属性に応じて `rw` フラグを設定します。
`rw == true` の場合は read/write になり、それ以外の場合は read-only になります。

なお、この関数は<u>新たなマッピングを作成することしか想定していない</u>ため、 TLB をフラッシュする必要がありません。
仮に既存のマップを変更するような場合には、CR3 をリロードするか `invlpg` 等の命令を使って TLB をフラッシュする必要があります。

新たにページテーブルを確保する関数は以下のように実装されています:

```zig
// -- surtr/arch/x86/page.zig --

fn allocateNewTable(T: type, entry: *T, bs: *BootServices) PageError!void {
    var ptr: Phys = undefined;
    const status = bs.allocatePages(.AllocateAnyPages, .BootServicesData, 1, @ptrCast(&ptr));
    if (status != .Success) return PageError.NoMemory;

    clearPage(ptr);
    entry.* = T.newMapTable(@ptrFromInt(ptr), true);
}

fn clearPage(addr: Phys) void {
    const page_ptr: [*]u8 = @ptrFromInt(addr);
    @memset(page_ptr[0..page_size_4k], 0);
}
```

Boot Services の [AllocatePages()](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#efi-boot-services-allocatepages) を使って1ページだけ確保します。
この際、メモリタイプは `BootServicesData`[^6] を指定します。
このページテーブルは Ymir が新たにマッピングを作成するまで Surtr から Ymir に処理が移っても使われ続けます。
他のチャプターで説明しますが、`BootServicesData` と指定することで Ymir 側からこの領域はページを新たにマッピングした場合に開放して良い領域であることを明示しています。

確保したページは `clearPage()` でゼロクリアしています。
最後に、エントリに新たに作成したページテーブルの物理アドレスをセットしています。

## Lv4 テーブルを writable にする

以上で 4KiB のページをマップできるようになりました。
実際に適当の仮想アドレスをマップできることを確認してみましょう。

`boot.zig` で以下のように適当なアドレスをマップします:

```zig
// -- surtr/boot.zig --

const arch = @import("arch.zig");

arch.page.map4kTo(
    0xFFFF_FFFF_DEAD_0000,
    0x10_0000,
    .read_write,
    boot_service,
) catch |err| {
    log.err("Failed to map 4KiB page: {?}", .{err});
    return .Aborted;
};
```

実行すると以下のようになります:

```txt
[DEBUG] (surtr): Kernel ELF information:
  Entry Point         : 0x10012B0
  Is 64-bit           : 1
  # of Program Headers: 4
  # of Section Headers: 16
!!!! X64 Exception Type - 0E(#PF - Page-Fault)  CPU Apic ID - 00000000 !!!!
ExceptionData - 0000000000000003  I:0 R:0 U:0 W:1 P:1 PK:0 SS:0 SGX:0
RIP  - 000000001E230E20, CS  - 0000000000000038, RFLAGS - 0000000000010206
RAX  - 000000001FC01FF8, RCX - 000000001E4DA103, RDX - 0007FFFFFFFFFFFF
RBX  - 0000000000000000, RSP - 000000001FE963B0, RBP - 000000001FE96420
RSI  - 0000000000000000, RDI - 000000001E284D18
R8   - 0000000000001000, R9  - 0000000000000000, R10 - 0000000000001000
R11  - 000000001FE96410, R12 - 0000000000000000, R13 - 000000001ED8D000
R14  - 0000000000000000, R15 - 000000001FEAFA20
DS   - 0000000000000030, ES  - 0000000000000030, FS  - 0000000000000030
GS   - 0000000000000030, SS  - 0000000000000030
CR0  - 0000000080010033, CR2 - 000000001FC01FF8, CR3 - 000000001FC01000
```

ページフォルトが発生してしまいました[^7]。
ページフォルトが発生したアドレスは CR2 に入っており、今回は `0x1FC01FF8` です。
このアドレスは、CR3 が指すページ、すなわち Lv4 テーブルが入っているページと一致しています。
オフセットの `0xFF8` は指定した仮想アドレス `0xFFFF_FFFF_DEAD_0000` に対応するテーブル内のエントリのオフセットです。
[gef](https://github.com/bata24/gef) の `vmmap` コマンドで Lv4 テーブルの様子を見てみます:

```txt
Virtual address start-end              Physical address start-end             Total size   Page size   Count  Flags
...
0x000000001fc00000-0x000000001fe00000  0x000000001fc00000-0x000000001fe00000  0x200000     0x200000    1      [R-X KERN ACCESSED DIRTY]
...
```

どうやら **UEFI が提供する Lv4 テーブルは read-only になっている** ようです。
このままでは Lv4 テーブル内のエントリを書き換えることができないため、
Lv4 テーブルを書き込み可能にする必要があります。

Lv4 テーブルが存在するページの属性を変更するためには、ページテーブルエントリを修正する必要があります。
しかし、そのエントリ自体が現在は read-only になっているため、変更を加えることができません。
よって、Lv4 テーブル自体を書き込み可能にするためには、Lv4 テーブル自体をコピーするしかありません。
以下のような関数を定義し、Lv4 テーブルを書き込み可能にします:

```zig
// -- surtr/arch/x86/page.zig --

pub fn setLv4Writable(bs: *BootServices) PageError!void {
    var new_lv4ptr: [*]Lv4Entry = undefined;
    const status = bs.allocatePages(.AllocateAnyPages, .BootServicesData, 1, @ptrCast(&new_lv4ptr));
    if (status != .Success) return PageError.NoMemory;

    const new_lv4tbl = new_lv4ptr[0..num_table_entries];
    const lv4tbl = getLv4Table(am.readCr3());
    @memcpy(new_lv4tbl, lv4tbl);

    am.loadCr3(@intFromPtr(new_lv4tbl.ptr));
}
```

Boot Services を利用して新たにページテーブルを確保し、現在の Lv4 テーブルをスブテコピーします。
最後に `loadCr3()` で CR3 を新しく確保した Lv4 テーブルの物理アドレスにセットします。
CR3 のリロードは全ての TLB をフラッシュするため、以降は新しい Lv4 テーブルが使われるようになります。
新しく作成したページテーブルには read-only の設定がされていないため、これで Lv4 テーブルを書き込み可能にできます。

`boot.zig` で 4KiB ページをマップする前に Lv4 テーブルを書き込み可能にしてみましょう:

```zig
// -- surtr/boot.zig --

arch.page.setLv4Writable(boot_service) catch |err| {
    log.err("Failed to set page table writable: {?}", .{err});
    return .LoadError;
};
log.debug("Set page table writable.", .{});
```

実行すると今度はページフォルトが起きずに正常に hlt ループまで実行されるはずです。
この時点でのページテーブルを見ると以下のようになっています:

```txt
Virtual address start-end              Physical address start-end             Total size   Page size   Count  Flags
0x0000000000000000-0x0000000000200000  0x0000000000000000-0x0000000000200000  0x200000     0x200000    1      [RWX KERN ACCESSED DIRTY]
...
0xffffffffdead0000-0xffffffffdead1000  0x0000000000100000-0x0000000000101000  0x1000       0x1000      1      [RWX KERN ACCESSED GLOBAL]
```

ちゃんと指定した仮想アドレス `0xFFFFFFFFDEAD0000` が 物理アドレス `0x100000` にマップされていることがわかります。

## アウトロ

本チャプターでは、4-level paging におけるページテーブルエントリの構造体を定義し、4KiB ページをマップする関数を実装しました。
実際に 4KiB ページをマップする際には、Lv4 テーブルが read-only になっているためページフォルトが発生してしまいます。
そのため、Lv4 テーブルを書き込み可能にするための関数を実装しました。

これで Ymir カーネルを要求されたアドレスにマップするための準備が整いました。
次回は、Ymir を実際にカーネルにロードする処理を実装します。

[^1]: 厳密には各エントリのフィールドには異なるものもありますが、本シリーズでは問題がなく簡単のために同じ構造体を使うことにします。
[^2]: このような構造体を *integer-backed packed struct* と呼びます。
フィールドの合計サイズが指定したサイズと異なる場合にはコンパイルエラーになります。
[^3]: UEFI が用意するページテーブルでは仮想アドレスと物理アドレスが同じになるように設定されているため、この2つを混同しても動いてしまいます。
[^4]: 結局の所どちらも `u64` であり、Zig では `Phys` を要求する場所で `u64` を渡してもエラーになってくれません。
`Phys` を要求する場所で `Virt` を渡しても同様にエラーになりません。
あくまでもコードを見る際のアノテーション的な意味合いで使っています。
[^5]: x64 では segmentation はほとんど使われないため、図中の *Linear-Address* は仮想アドレスとほぼ同義です。
[^6]: [Memory Type Usage before ExitBootServices() - UEFI Specification 2.9A](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-type-usage-before-exitbootservices)
[^7]: この例外ハンドラは UEFI が用意してくれたものです。
