# 簡易版ページテーブル

前回で Ymir の ELF イメージをファイルかリードすることができるようになりました。
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

![Linear-Address Translation to a 4-KByte Page Using 4-Level Paging](../assets/sdm/address-translation-4level.png)
*Linear-Address Translation to a 4-KByte Page Using 4-Level Paging. SDM Vol.3A 4.5.4*

![Formats of CR3 and Paging-Structure Entries with 4-Level Paging](../assets/sdm/paging-structure-entries.png)
*Formats of CR3 and Paging-Structure Entries with 4-Level Paging. SDM Vol.3A 4.5.5*

```zig
const TableLevel = enum {
    lv4,
    lv3,
    lv2,
    lv1,
};

fn EntryBase(table_level: TableLevel) type {
    return packed struct(u64) {
        const Self = @This();
        const level = table_level;
        const LowerType = switch (level) {
            .lv4 => Lv3Entry,
            .lv3 => Lv2Entry,
            .lv2 => Lv1Entry,
            .lv1 => struct {},
        };

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
```
