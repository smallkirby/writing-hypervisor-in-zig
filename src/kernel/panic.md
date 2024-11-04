# パニック実装

本チャプターでは `@panic()` の実装をします。

> [!NOTE] スキップ可能
> 本チャプターはまるごとスキップして次のチャプターに進んでも問題ありません。

## Table of Contents

<!-- toc -->

## デフォルトパニック

Zig の [@panic()](https://ziglang.org/documentation/master/#panic) はプログラムが復帰不可能なエラーに遭遇した場合に呼び出され、プログラムを終了させます。
`@panic()` は単に登録されたパニックハンドラを呼び出すのですが、このハンドラは[プラットフォーム依存](https://github.com/ziglang/zig/blob/3054486d1dedd49553680da2c074d1ab413797fd/lib/std/debug.zig#L462)です。
通常の OS の場合は指定したメッセージを表示した上でスタックトレースも表示してくれます。
しかしながら、`.freestanding` な環境でのデフォルトのパニックハンドラは単に `@trap()` を呼ぶだけです。
指定したメッセージを表示することすらしてくれません。

これでは不便なので、Ymir では自前のパニックハンドラを実装することにします。
このハンドラはまず指定されたメッセージをシリアル出力します。
また、スタックトレースも表示します。
最後に Ymir を終了させるのではなく無限ループさせることにします。
これは GDB でアタッチしてデバッグする機会を与えるためです。

## メッセージの表示

Zig のパニックハンドラは3つの引数を取ります。
1つ目は出力するメッセージです。
ログ系の関数とは異なるフォーマット出力をすることはできないため、メッセージ用の引数はこの1つだけです。
2つ目と3つ目はスタックトレース関連の情報なのですが、`.freestanding` ではこれらの引数は常に `null` でした。
スタックトレースはレジスタの状態から自前で取得することができるため問題ありません。
以下のパニックハンドラを定義します:

```ymir/panic.zig
var panicked = false;

fn panic(msg: []const u8, _: ?*builtin.StackTrace, _: ?usize) noreturn {
    @setCold(true);
    arch.disableIntr();
    log.err("{s}", .{msg});

    if (panicked) {
        log.err("Double panic detected. Halting.", .{});
        ymir.endlessHalt();
    }
    panicked = true;

    ... // スタックトレースの表示

    ymir.endlessHalt();
}
```

`@setCold()` はこの関数(ブランチ)がめったに呼ばれないことを示します。
なぜかは分かりませんが、Zig のドキュメントにはこのビルトイン関数についての記述がありません。
おそらく [@branchHint()](https://ziglang.org/documentation/master/#branchHint) と似たようなものだと思われます。
きっとコンパイラに最適化のヒントを与えてくれるものだと思っています、多分。

パニックハンドラの中では割り込みを無効化し、メッセージを出力します。
出力には他のファイルと同様に `std.log` を使用します。
ログ関数は既にシリアルを利用するように実装されているため、パニック実装で自前のシリアル出力を用意する必要はありません。

なお、パニックハンドラの中でもパニックが発生する可能性が否定できません。
そのためグローバル変数に `panicked` という変数を用意しておき、一度パニックハンドラが呼び出されたらこのフラグを立てるようにしておきます。
このフラグが立っている時にハンドラが呼ばれたら何もせずに終了するようにしています。

パニックハンドラの最後には無限 HLT ループに入るようにします:

```ymir/ymir.zig
pub fn endlessHalt() noreturn {
    arch.disableIntr();
    while (true) arch.halt();
}
```

## スタックトレース

続いて、スタックトレースの表示をします。
スタックトレースは RSP / RBP の値を順に辿っていくことで取得することができます。
Zig にはスタックトレースを取得するためのユーティリティ構造体である `StackIterator` があるため今回はこれを使います:

```ymir/panic.zig
fn panic(msg: []const u8, _: ?*builtin.StackTrace, _: ?usize) noreturn {
    ...
    var it = std.debug.StackIterator.init(@returnAddress(), null);
    var ix: usize = 0;
    log.err("=== Stack Trace ==============", .{});
    while (it.next()) |frame| : (ix += 1) {
        log.err("#{d:0>2}: 0x{X:0>16}", .{ ix, frame });
    }
    ...
}
```

本来であればスタックトレースにはファイル名・関数名・行番号なども表示できると嬉しいところですが、Ymir では実装しません。
Zig には `std.dwarf` というライブラリが DWARF デバッグ情報を取り扱うことができるらしいため、実装したい人は活用すると良いかもしれません。

## デフォルトハンドラの上書き

Zig のデフォルトのパニックハンドラを上書きするには、Root Source File において `panic()` 関数を定義します:

```ymir/main.zig
pub const panic = ymir.panic.panic_fn;
```

それでは実際にパニックさせてみましょう。
なお、最適化レベルは `Debug` にしておくのがおすすめです。
`ReleaseFast` レベルだと最適化が結構強く働くため、関数がインライン化されてスタックトレースが出力できない場合があります:

```zig
panic("fugafuga");
```

出力は以下のようになります:

```txt
[ERROR] panic   | fugafuga
[ERROR] panic   | === Stack Trace ==============
[ERROR] panic   | #00: 0xFFFFFFFF80100D3E
[ERROR] panic   | #01: 0xFFFFFFFF80103590
```

ちゃんとスタックトレースが出力されていることが分かります。
デバッグ情報がないためソースファイルにおける行番号などは表示されませんが、
それらは `addr2line` コマンドで実現することができます:

```sh
> addr2line -e ./zig-out/bin/ymir.elf 0xFFFFFFFF80100D3E
/home/lysithea/ymir/ymir/main.zig:95
```
