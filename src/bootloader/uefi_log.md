# UEFI でログ出力

Surtr の雛形ができたので、次にやりたいことはログ出力です。
ログ出力はデバッグをする上でも非常に重要なので先にやってしまいましょう。
今回は UEFI の [Simple Text Output](https://uefi.org/specs/UEFI/2.9_A/12_Protocols_Console_Support.html) というプロトコルを利用してログを出力していきます。

## Table of Contents

<!-- toc -->

## System Table と Simple Text Output Protocol

UEFI では [EFI System Table](https://uefi.org/specs/UEFI/2.9_A/04_EFI_System_Table.html#efi-system-table-1) というテーブルに各種ランタイムサービス・ブートサービスへのポインタが格納されています。
その中でも、`ConOut` というフィールドには
[EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL](https://uefi.org/specs/UEFI/2.9_A/12_Protocols_Console_Support.html#efi-simple-text-output-protocol) インタフェースへのポインタが格納されています。
このプロトコルを利用することで、テキスト出力を容易に行えます。

System Table へのポインタは `std.os.uefi.system_table` に入っています。
ここから Simple Output Protocol へのポインタを取得します:

```zig
// -- surtr/boot.zig -- //

var status: uefi.Status = undefined;

const con_out = uefi.system_table.con_out orelse return .Aborted;
status = con_out.clearScreen();
```

Simple Output Protocol を取得後、[`clearScreen()`](https://uefi.org/specs/UEFI/2.9_A/12_Protocols_Console_Support.html#efi-simple-text-output-protocol-clearscreen)を呼んで画面をクリアします。
これによって、前チャプターで表示されていた `BdsDxe: loading Boot0001...` のような出力が消えてまっさらな画面が表示されるはずです。

画面への文字列出力には [outputString()](https://uefi.org/specs/UEFI/2.9_A/12_Protocols_Console_Support.html#efi-simple-text-output-protocol-outputstring) を使います。
ただし、ここで渡す文字列は [UCS-2](https://e-words.jp/w/UCS-2.html) という文字列集合を使います。
UCS-2 は1文字を2バイトで表現します。
詳しいことは他の文献に譲るとして、ASCII文字の範囲内であれば `<8bit ASCII code> <0x00>` という2バイトで1文字が表されるという事実だけをここでは利用します。
よって、`"Hello, world!"`という文字列は以下のようにして出力できます:

```zig
for ("Hello, world!\n") |b| {
    con_out.outputString(&[_:0]u16{ b }).err() catch unreachable;
}
```

Zig において、文字列リテラルは `[N:0]const u8` という [Sentinel-Terminated Arrays](https://ziglang.org/documentation/master/#Sentinel-Terminated-Arrays) 型になります。
言い換えれば NULL 終端された配列です。
よって、`for`ループで使う変数の `b` は `const u8` 型になります。
`outputString()`の引数の型は `[*:0]const u16` であるため、`u8`型を`u16`型に変換する必要があります。
`for`ループの中身の `&[_:0]u16{ b }` では `u8` 型の `b` を `u16` 型に変換しています。

<div class="warning">
Zig における配列

Zig において、配列の初期化は以下のように行います:

```zig
const array = [3]u8 { 0, 1, 2 };
```

ただし、配列のサイズが明らかである場合にはサイズを `_` で省略できます:

```zig
const array = [_]u8 { 0, 1, 2 };
```

また、NULL終端された配列は以下のように初期化できます:

```zig
const array = [_:0]u8 { 0, 1, 2 };
```

この場合、`array.len == 4` ではありますが `array[4]` にアクセスでき、その値は `0` になります。
</div>

## ログ実装のオーバーライド

Zig では `std.log.info()` のような関数でログを出力できます。
これらの関数の実体である [std.log.log()](https://github.com/ziglang/zig/blob/bdd3bc056ee998770ea48a93b4ec99521f069aed/lib/std/log.zig#L117) は `std_options.logFn` を呼び出します。
これはデフォルトでは [defaultLog()](https://github.com/ziglang/zig/blob/bdd3bc056ee998770ea48a93b4ec99521f069aed/lib/std/log.zig#L143) になっています。
この関数は内部で OS ごとの分岐をするのですが、`os.uefi` においてはコンパイルできないような分岐になっています。
よって `std_options.logFn` をオーバーライドし、**Simple Text Output を利用するような独自のログ関数を実装してあげる必要があります**。

`surtr/log.zig` を作成し、ログ関数を実装してあげます:

```zig
// -- surtr/log.zig -- //

fn log(
    comptime level: stdlog.Level,
    scope: @Type(.EnumLiteral),
    comptime fmt: []const u8,
    args: anytype,
) void {
    _ = level;
    _ = scope;

    std.fmt.format(
        Writer{ .context = {} },
        fmt ++ "\r\n",
        args,
    ) catch unreachable;
}
```

`logFn` のシグネチャのとおりに関数を定義してあげます。
`level`と`scope`については一旦使わないので `_` に代入しておきます。
`std.fmt.format()` はフォーマット文字列と引数から文字列を生成し、それを第1引数の`Writer`に書き込む関数です。
`Writer`型は、以下のように定義します:

```zig
// -- surtr/log.zig -- //

const Writer = std.io.Writer(
    void,
    LogError,
    writerFunction,
);
const LogError = error{};
```

第1引数は`Writer`が呼び出された時に利用できるコンテキストです。今回はコンテキストが必要ないため`void`を指定します。
第2引数はこの`Writer`が返すエラー型です。エラーは返さないため、空のエラー型`LogError`を定義し、それを指定しておきます。
最も重要な第3引数では実際に出力をする関数を指定します:

```zig
// -- surtr/log.zig -- //

fn writerFunction(_: void, bytes: []const u8) LogError!usize {
    for (bytes) |b| {
        con_out.outputString(&[_:0]u16{b}).err() catch unreachable;
    }
    return bytes.len;
}
```

第1引数のコンテキストは`Writer`型の定義時に指定した型です。今回は`void`型を指定しており使わないため、最初から`_`で無視しています。
`bytes`が出力する文字列です。
先程 `"Hello, world!"` を出力したときと同様に、UCS-2 に変換して `outputString()` に渡してあげます。

これで独自のログ関数を実装できました。
あとは `std.options.logFn` にこの関数をセットしてオーバーライドしてあげるだけです:

```zig
// -- surtr/log.zig -- //

pub const default_log_options = std.Options{
    .logFn = log,
};
```

ドキュメントされていませんが、`std_options` 変数は `build.zig` の `root_source_file` で指定したファイル以外オーバーライドできないようです。
そのため、`default_log_options` 変数を `pub` 指定して `boot.zig` から触れるようにしています。
`boot.zig` においてこの変数を参照し、 `std_options` 変数をオーバーライドします:

```zig
// -- surtr/boot.zig -- //

const blog = @import("log.zig");
pub const std_options = blog.default_log_options;
```

これで `std.log.info()` を呼び出すと、独自に実装したログ関数が呼び出されるようになりました。

## ログの初期化

ログ関数をオーバーライドしただけでは、ログが出力されるようにはなりません。
`writerFunction()` で利用している `con_out` 変数を `log.zig` に渡してグローバル変数としてセットしてあげる必要があります。
ログを出力する関数を用意します:

```zig
// -- surtr/log.zig -- //

const Sto = uefi.protocol.SimpleTextOutput;

var con_out: *Sto = undefined;

/// Initialize bootloader log.
pub fn init(out: *Sto) void {
    con_out = out;
}
```

あとは先程取得した Simple Text Output Protocol のポインタを渡してあげればログが出力されるようになります:

```zig
// -- surtr/boot.zig -- //

cosnt log = std.log;

blog.init(con_out);
log.info("Initialized bootloader log.", .{});
```

QEMU を動かしてログが出力されるかどうかを確認してください。

<div class="warning">
unreachable

Zig において関数は [Error Union Type](https://ziglang.org/documentation/master/#Error-Union-Type) を返します。
この型は、エラー型と成功時の型の両方を合わせた `LogError!u32` のようなかたちをしています。
エラーとして任意の方を許容する場合には `!u32` のように書くこともできます。
逆にエラーを一切返さない場合には `u32` と書けます。

関数を呼び出したとき、その関数がエラーを返す可能性がある場合には `catch` で受けることでエラーを処理できます:

```zig
const value = SomeFunction() catch |err| {
    log.error("SomeFunction failed: {?}", .{err});
    @panic();
}
```

エラーが返されなかった場合、`catch` ブロックは実行されず、`value` には関数の返り値が代入されます。
先程の `writerFunction()` では `outputString()` がエラーを返す可能性があるため、`catch unreachable` でエラーを処理しています。

ここで、`unreachable`の意味は**ビルドの最適化レベルによって変化します**。
`Debug` と `ReleaseSafe` レベルの場合、`unreachable` は `@panic()` を引き起こします。
それ以外の場合には、`unreachable`は「到達することがない」というアノテーションとして働くため、
実際にその箇所に到達してしまった場合の挙動は未定義です。
実行される可能性がある箇所に `unreachable` を置かないように気をつけましょう。
</div>

## ログのスコープ

ここまででログの出力ができるようになりました。
これで終わっても十分なのですが、せっかくなのでもう少しZigのログの良さを活かしてみましょう。

Zig ではログにスコープをもたせることができます:

```zig
const log = std.log.scoped(.hoge);
log.info("Hello, from hoge scope", .{});
```

`scoped(.hoge)` は、`hoge` というスコープが与えられた新しいログ関数たちを生成してくれます。
先程実装した `log()` 関数の第2引数ではこのスコープを受け取ることができます。
スコープを出力してあげるように修正しましょう:

```zig
// -- surtr/log.zig -- //

fn log(
    comptime level: stdlog.Level,
    scope: @Type(.EnumLiteral),
    comptime fmt: []const u8,
    args: anytype,
) void {
    _ = level;
    const scope_str = if (scope == .default) ": " else "(" ++ @tagName(scope) ++ "): ";

    std.fmt.format(
        Writer{ .context = {} },
        scope_str ++ fmt ++ "\r\n",
        args,
    ) catch unreachable;
}
```

受け取った`scope`が`.default`以外の場合には、`(<SCOPE>)` という文字列を作成し、それを出力するようにしています。
Zig では配列を `++` 演算子で結合できるため、これを利用しています。
これらの処理はコンパイル時に行われるため、実行時のオーバーヘッドはありません。

`boot.zig` では、スコープを `.surtr` として Surtr からの出力であることがわかりやすいようにします:

```zig
// -- surtr/boot.zig -- //

const log = std.log.scoped(.surtr);
log.info("Hello, world!", .{});
```

以下のような出力になるはずです:

```txt
(surtr): Hello, world!
```

## ログレベル

ログの最後の要素はログレベルです。
Zig のログレベルは `std.log.Level` enum として定義されており、`err`/`warn`/`info`/`debug` の4つがあります。
デフォルトのログレベルは[最適化レベルによって決まります](https://github.com/ziglang/zig/blob/bdd3bc056ee998770ea48a93b4ec99521f069aed/lib/std/log.zig#L101-L106)。
プログラムのログレベルより低いログは出力されず、コンパイル時に削除されます。

ここでは、分かりやすいようにログレベルも出力してみましょう:

```zig
// -- surtr/log.zig -- //

fn log(
    comptime level: stdlog.Level,
    scope: @Type(.EnumLiteral),
    comptime fmt: []const u8,
    args: anytype,
) void {
    const level_str = comptime switch (level) {
        .debug => "[DEBUG]",
        .info => "[INFO ]",
        .warn => "[WARN ]",
        .err => "[ERROR]",
    };
    const scope_str = if (scope == .default) ": " else "(" ++ @tagName(scope) ++ "): ";

    std.fmt.format(
        Writer{ .context = {} },
        level_str ++ " " ++ scope_str ++ fmt ++ "\r\n",
        args,
    ) catch unreachable;
}
```

`comptime switch` はコンパイル時に評価される `switch` 文です。
`level` に対応する文字列を生成し、スコープ文字列のように `fmt` と結合して出力しています。
この状態でログを出力すると以下のようになるはずです:

```txt
[INFO ] (surtr): Hello, world!
```

## ログレベルの変更

ログレベルはコード中で `std_options.log_level` にセットすることで変更できます。
しかし、わざわざログレベルを変更するためにコードを書き換えるのはめんどうですね。
ビルドスクリプトを変更し、ビルド時にログレベルを変更できるようにしましょう:

```zig
// -- build.zig -- //

// Options
const s_log_level = b.option(
    []const u8,
    "log_level",
    "log_level",
) orelse "info";
const log_level: std.log.Level = b: {
    const eql = std.mem.eql;
    break :b if (eql(u8, s_log_level, "debug"))
        .debug
    else if (eql(u8, s_log_level, "info"))
        .info
    else if (eql(u8, s_log_level, "warn"))
        .warn
    else if (eql(u8, s_log_level, "error"))
        .err
    else
        @panic("Invalid log level");
};

// 新たなオプションの作成
const options = b.addOptions();
options.addOption(std.log.Level, "log_level", log_level);

// Surtr にオプションの追加
surtr.root_module.addOptions("option", options);
```

`b.option` によって、新たなコマンドライン引数を定義しています。
引数で受け取った文字列を4つの enum 値に変換し、`addOption()` で新たに `log_level` という名前のオプションとして追加します。

ここで追加したオプションは、コード中で以下のように参照できます:

```zig
// -- surtr/log.zig -- //

const optoin = @import("option"); // build.zig で指定したオプション名
const log_level = option.log_level;
```

`log_level` はコンパイル時に決定する値として利用できます。
この値を `std_options.log_level` にセットしてあげましょう:

```zig
// -- surtr/log.zig -- //

pub const default_log_options = std.Options{
    .log_level = switch (option.log_level) {
        .debug => .debug,
        .info => .info,
        .warn => .warn,
        .err => .err,
    },
    .logFn = log,
};
```

あとはビルド時にこのオプションを指定してあげれば、ログレベルが変更されます。
試しに `log.info()` でログ出力するように指定してあげた上で、コンパイル時にログレベルとして `.warn` を指定してみましょう:

```bash
zig build -Dlog_level=warn -Doptimize=Debug
```

QEMUの出力からログ出力が消えるはずです。

以上で Surtr におけるログシステムの実装は完了です。
好きな文字列を出力できるようになりました。
もちろん、フォーマット文字列も利用できます。
今後の開発が捗ること間違いなしですね。

## References

- [フルスクラッチで作る!UEFIベアメタルプログラミング](http://yuma.ohgami.jp/UEFI-Bare-Metal-Programming/index.html)
- [UEFI Specification 2.9 Errata A](https://uefi.org/specs/UEFI/2.9_A/index.html)
