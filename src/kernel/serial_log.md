# シリアルコンソールによるログ出力

前回で Ymir が起動しました。
まず最初にやることは、何はともあれログ出力です。
[Surtr のとき](../bootloader/uefi_log.md)と同様ですね。

ログ出力にはシリアルポート[^serial]を使います。
`build.zig` で設定した起動オプションにより、QEMU はシリアルポートを標準出力にリダイレクトしてくれます。
このログ出力が実装できれば続く開発が楽になります。

## Table of Contents

<!-- toc -->

## arch ディレクトリの作成

### x86 ディレクトリ

[Surtr のとき](../bootloader/simple_pg.md) と同様に、アーキテクチャに強く依存するコードはディレクトリを分けて実装します。
Ymir のディレクトリは以下のようになります:

```sh
tree ./ymir

./ymir
├── arch
│   └── x86
│       ├── arch.zig
│       ├── asm.zig
│       └── serial.zig
├── arch.zig
├── linker.ld
└── main.zig
```

`ymir/arch.zig` の内容は `surtr/arch.zig` と同じです。
`ymir/arch/x86/arch.zig` を上位のディレクトリに export する目的です。

`ymir/arch/x86/arch.zig` は、`ymir/arch/x86` ディレクトリにおけるルートです。
アーキテクチャ依存のコードを `ymir/arch` より上のディレクトリから利用する際には、必ずこのファイルを import して使うことにします。
`ymir/arch/x86/arch.zig` は以下のようにしておきます:

```zig
// -- ymir/arch/x86/arch.zig --

pub const serial = @import("serial.zig");
const am = @import("asm.zig");
```

`serial.zig` は `pub` なので `arch.serial` として上位ディレクトリからアクセスできます。
`asm.zig` は `pub` がついていないため、`arch` ディレクトリ以外からアクセスできません。
アーキテクチャ依存のコードをできるだけ隠したいため、アセンブリ関連のコードは `asm.zig` にまとめて隠していきます。

### `ymir` モジュールの作成

現在のところ、`ymir/hoge/fuga.zig` から `ymir/piyo/neko.zig` を参照するためには、
以下のように相対パスで指定する必要があります:

```zig
const fuga = @import("../piyo/neko.zig");
```

これは見た目が気持ち悪いだけではなく、以下のように **誤って秘匿したいモジュールを参照してしまう可能性** があります:

```zig
const am = @import("arch/x86/asm.zig"); // 本来はアクセスさせたくない
```

これを防ぐため、ルートモジュールを作成し、**全てのモジュールはルートモジュールを経由してアクセスさせる** ことにします。
モジュールの作成は Surtr のときと同様に `build.zig` で定義します:

```zig
// -- build.zig --

const ymir_module = b.createModule(.{
    .root_source_file = b.path("ymir/ymir.zig"),
});
ymir_module.addImport("ymir", ymir_module);
ymir_module.addImport("surtr", surtr_module);
```

定義した `ymir` モジュールを `ymir` 実行ファイルに追加します:

```zig
// -- build.zig --

ymir.root_module.addImport("ymir", ymir_module);
```

これで、`@import("ymir")` のようにモジュール名で Ymir モジュールを import できるようになりました。
モジュールのルートである `ymir/ymir.zig` は、必要な全ての子モジュールを export します:

```zig
// -- ymir/ymir.zig --

pub const arch = @import("arch.zig");
```

これで、全てのファイルから `@import("ymir").arch` のようにして `arch/x86/arch.zig` にアクセスできるようになりました。
試しに、`arch/x86/arch.zig` で適当な関数を定義して `main.zig` からアクセスしてみましょう:

```zig
// -- ymir/arch/x86/arch.zig --
pub fn someFunction() void {}

// -- ymir/main.zig --
const ymir = @import("ymir");
const arch = ymir.arch;
arch.someFunction();
```

`std` と同じノリで `ymir` モジュールにアクセスできますね。
これ以降は意図しない import を防ぐため、**同一ディレクトリ以外のファイルを相対パスを使って直接 import することは原則禁止**とします。

<div class="warning">
ymir への ymir の追加

Zig に馴染みがない人は、`ymir` executable に `ymir` モジュールを追加するというのは気持ち悪いかもしれません。
筆者も当初は違和感を感じたため [Ziggit](https://ziggit.dev/) で聞いてみたところ、このような書き方は合法なのは勿論、自然であるとのことでした[^self-dependent]。
</div>

## シリアルの基本の定義

今回想定するのは [8250 UART](https://en.wikipedia.org/wiki/8250_UART) です。
入力と出力のどちらもできますが、このチャプターでは出力のみを扱います。

シリアルポートにおける定数や構造体を定義していきます。
まずは COM portです。
COM port は I/O port を介してアクセスします。
COM port と I/O port の対応関係を定義するため、`ymir/arch/x86/serial.zig` を作成します:

```zig
// -- ymir/arch/x86/serial.zig --

pub const Ports = enum(u16) {
    com1 = 0x3F8,
    com2 = 0x2F8,
    com3 = 0x3E8,
    com4 = 0x2E8,
};
```

今回は4つだけポートを定義します。
実際のHWによってはもっと多いかもしれませんし、もっと少ないかもしれません。
Ymir では COM1 を使います。

各ポートはそれぞれの data register を持っています。
Data register へは COM port をベースとしたオフセットでアクセスします:

```zig
// -- ymir/arch/x86/serial.zig --

const offsets = struct {
    /// Transmitter Holding Buffer: DLAB=0, W
    pub const txr = 0;
    /// Receiver Buffer: DLAB=0, R
    pub const rxr = 0;
    /// Divisor Latch Low Byte: DLAB=1, R/W
    pub const dll = 0;
    /// Interrupt Enable Register: DLAB=0, R/W
    pub const ier = 1;
    /// Divisor Latch High Byte: DLAB=1, R/W
    pub const dlm = 1;
    /// Interrupt Identification Register: DLAB=X, R
    pub const iir = 2;
    /// FIFO Control Register: DLAB=X, W
    pub const fcr = 2;
    /// Line Control Register: DLAB=X, R/W
    pub const lcr = 3;
    /// Line Control Register: DLAB=0, R/W
    pub const mcr = 4;
    /// Line Status Register: DLAB=X, R
    pub const lsr = 5;
    /// Modem Status Register: DLAB=X, R
    pub const msr = 6;
    /// Scratch Register: DLAB=X, R/W
    pub const sr = 7;
};
```

実際には、オフセット・アクセスが read/write のどちらなのか・、その時の **DLAB** の値 の3要素によってアクセスするレジスタが異なります。
どのような場合にどのレジスタにアクセスするのかは、`offsets` 内のコメントまたは参考文献[^serial]を参照してください。

## 初期化

シリアルの初期化を行います。

COM port へのアクセスは、対応する I/O port への `in`/`out` 命令を使っておこないます。
必要なアセンブリ命令を定義しておきます:

```zig
// -- ymir/arch/x86/asm.zig --

pub inline fn inb(port: u16) u8 {
    return asm volatile (
        \\inb %[port], %[ret]
        : [ret] "={al}" (-> u8),
        : [port] "{dx}" (port),
    );
}

pub inline fn outb(value: u8, port: u16) void {
    asm volatile (
        \\outb %[value], %[port]
        :
        : [value] "{al}" (value),
          [port] "{dx}" (port),
    );
}
```

TODO

[^serial]: [Serial Ports - OSDev Wiki](https://wiki.osdev.org/Serial_Ports)
[^self-dependent]: [ZLS does not work for @import(“root”) when multiple artifacts are installed - Ziggit](https://ziggit.dev/t/zls-does-not-work-for-import-root-when-multiple-artifacts-are-installed/4190)
