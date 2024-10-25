# ビット演算ライブラリと Zig Test

本チャプターでは、ビット演算ライブラリを実装します。
ハードウェア、とりわけ CPU の設定を直接行う Ymir では、ビット演算が頻繁に使われます。
Zig においてビット演算はそこまで便利なシンタックスや標準ライブラリが用意されているわけではないため、自前で実装してしまいます。
また、ライブラリに対してテストを書くことで Zig におけるテストの書き方を導入します。

## Table of Contents

<!-- toc -->

## ビット演算ライブラリ

`bits.zig` というファイルを作成したあと、`ymir.zig` において `pub` 指定します:

```ymir/ymir.zig
pub const bits = @import("bits.zig");
```

これにより、`bits.zig` に実装した関数を任意のファイルから以下のようにして呼び出すことができます:

```zig
const ymir = @import("ymir");
const bits = ymir.bits;

bits.foobar();
```

### 特定のビットを立てる

最初に実装するのは、ある整数 `N` を受取り、`N`番目のビットのみを立てた整数値を返す `tobit()` 関数です。
使いみちとしては、IRQ の3番の割り込みを無効化したい場合に `0b0000_1000` というマスクを作成したいような場合です。
愚直に実装すると `1 << N` ですが、`1`の型を明示する必要があったり、`N`がシフトを許されている値の範囲内であるかをチェックするなど想定以上にコード行数が増えてしまいます。
また、`N` が enum である場合には都度 `@intFromEnum()` を呼び出す必要があります。

`tobits()` は任意の型 `T` に対して呼び出せるようにします:

```ymir/bits.zig
pub fn tobit(T: type, nth: anytype) T {
    const val = switch (@typeInfo(@TypeOf(nth))) {
        .Int, .ComptimeInt => nth,
        .Enum => @intFromEnum(nth),
        else => @compileError("setbit: invalid type"),
    };
    return @as(T, 1) << @intCast(val);
}
```

最初の `switch` で `T` の型によって処理を分岐します。
現在対応しているのは整数値と enum の2つです。
enum であった場合には `@intFromEnum()` を呼び出して整数値に変換します。
最後に、変換後の整数値分だけ `1` をシフトさせれば完了です。

この関数は以下のように利用できます:

```zig
const Irq = enum(u8) { keyboard = 1 };
const irq: Irq = .keyboard;
const mask = bits.tobit(u8, irq);
```

> [!TIP] シフトと型
> `@as(T, 1) << N` において、例えば `T` が `u8` である場合には、オーバーフロー無しでシフトできる `N` の最大値は `7` です。
> よって、**Zig は `N` が `u3` よりも小さい整数型であることを要求します**。
> `@intCast(N)` は、`N` が `u3`型にキャストできるかどうかを実行時にチェックしてくれるため、コンパイルエラーを防ぐことができます。

### 特定のビットが立っているか確認する

続いて、ある整数値において特定のビットが立っているかを確認する `isset()` 関数を実装します:

```zig
pub inline fn isset(val: anytype, nth: anytype) bool {
    const int_nth = switch (@typeInfo(@TypeOf(nth))) {
        .Int, .ComptimeInt => nth,
        .Enum => @intFromEnum(nth),
        else => @compileError("isset: invalid type"),
    };
    return ((val >> @intCast(int_nth)) & 1) != 0;
}
```

ほとんど `tobit()` と同じです。
ただし、右シフトでは `val` の整数型が何であろうとOKであるため、`T` を引数に取る必要がないです。

### 2つの整数を連結する

`u32`型の整数 `a` と `b` を受取り、それらを連結して`u64`型の整数をつくりたいということもしばしばあります。
例として、[WRMSR](https://www.felixcloutier.com/x86/wrmsr) 命令は EDX と EAX を連結した値を MSR に書き込みます。
普通に書くと `@as(u64, a) << 32 | @as(u64, b)` となりますが、これをラップする `concat()` 関数を作成します:

```zig
pub inline fn concat(T: type, a: anytype, b: @TypeOf(a)) T {
    const U = @TypeOf(a);
    const width_T = @typeInfo(T).Int.bits;
    const width_U = switch (@typeInfo(U)) {
        .Int => |t| t.bits,
        .ComptimeInt => width_T / 2,
        else => @compileError("concat: invalid type"),
    };
    if (width_T != width_U * 2) @compileError("concat: invalid type");
    return (@as(T, a) << width_U) | @as(T, b);
}
```

今までよりも少しだけ複雑ですね。
引数の `a` と `b` は同じ型であることを強制します。
`anytype` の型は自動的に `comptime` になるため、引数の型として他の引数の型を `@TypeOf()` で取得できます。
また、最終的に生成する型 `T`の幅(`width_T`) は `a` と `b` の型の幅の2倍(`width_U`)である必要があります。
もしもそうでない場合には `@compileError()` でコンパイルエラーを発生させます。
この関数は enum には対応していません。

以下のように利用できます:

```zig
const a: u32 = 0x1234_5678;
const b: u32 = 0x9ABC_DEF0;
const c = bits.concat(u64, a, b); // 0x1234_5678_9ABC_DEF0
```

## テストの作成

このようなライブラリを作ると、テストを書きたくなるのが人のサガというものです。

Surtr や Ymir 全体に対してテストを書くというのは簡単なことではありません。
というのも、**ベアメタルで動作する Surtr や Ymir はユーザランドでテストできない**からです。
テストをしたい場合には、実行時にとある条件を満たしているかを assert してテストするくらいしかありません。
本シリーズでは、そのようなアーキテクチャ依存のコードを含む実行ファイルのテストは扱いません。
興味がある人は自前で実装してみてください。

> [!INFO] ランタイムテスト
> Zig では実行ファイルをテスト用にビルドすると `@import("builtin").is_test` の値が `true` になります。
> この値を `ymir.zig` で export することで、ランタイムテストをしたいファイルから容易に参照できるようになります:
>
> ```src/ymir.zig
> pub const is_test = @import("builtin").is_test;
> ```
>
> ランタイムテストをしたい場合には、 `if (ymir.is_test) { ... }` というように条件分岐を行います。
> この条件分岐はコンパイル時に評価されるため、非テスト用の実行ファイルでオーバーヘッドは発生しません。

一方で、今回実装したライブラリのようなコードに対してテストを書くことは容易です。
アーキテクチャ依存のコードを持たないため、ユーザランドで実行できます。
以下では、`bits.zig` に対してユニットテストを書いてみます。

### ビルド設定

まずは Ymir のユニットテスト用のビルドターゲットを追加します:

```build.zig
const ymir_tests = b.addTest(.{
    .name = "Unit Test",
    .root_source_file = b.path("ymir/ymir.zig"),
    .target = b.standardTargetOptions(.{}),
    .optimize = optimize,
    .link_libc = true,
});
ymir_tests.root_module.addImport("ymir", &ymir_tests.root_module);
```

テストにおけるルートファイルは `ymir/ymir.zig` とします。
`.target` は Ymir executable とは異なりホストOSのユーザランドで動かせばよいため、
デフォルトである `b.standardTargetOptions(.{})` を指定します。
また、依存として Ymir モジュールを指定します。

これは Ymir のユニットテスト用ターゲットを追加しただけであり、まだ実行するためのターゲットがありません。
実行するためのターゲットも追加します:

```build.zig
const run_ymir_tests = b.addRunArtifact(ymir_tests);
const test_step = b.step("test", "Run unit tests");
test_step.dependOn(&run_ymir_tests.step);
```

これにより、`test` というターゲットを指定することでユニットテストを実行できるようになります。

### テストの定義

Zig において、テストは `test {}` ブロック内に記述します。
例として、`tobit()` に対するテストを書いてみます:

```ymir/bits.zig
const testing = @import("std").testing;

test "tobit" {
    try testing.expectEqual(0b0000_0001, tobit(u8, 0));
    try testing.expectEqual(0b0001_0000, tobit(u8, 4));
    try testing.expectEqual(0b1000_0000, tobit(u8, 7));
}
```

テストを実行してみましょう:

```bash
> zig build test --summary all
Build Summary: 3/3 steps succeeded
test success
└─ run Unit Test success 678us MaxRSS:1M
   └─ zig test Unit Test Debug native success 1s MaxRSS:204M
```

非常に分かりにくいですが、**実はテストは1つも実行されていません**...。
現段階の Zig は、実行されたテストの一覧を表示する簡単な方法がありません。
そのせいで、テストが実行されているかどうかを確認するのがぱっと見で分かりにくいという問題があります。

それはさておき、**テストが実行されていない理由は `bits.zig` 自体が評価されていないから**です。
Zig では、「あらゆるものは参照されるまで評価されない」という原則があります。
今回の場合、ルートファイルである `ymir.zig` から `bits.zig` が参照されていません。
`@import("bits.zig")` はされていますが、実際にその中身が利用されていないため、Zig はこのファイルを評価しません。
その証拠に、`bits.zig` の末尾などに `hogehoge` という明らかに不正なコードを追加して `zig build test` してもエラーになりません。
**参照されていないため評価されず、評価されない限りはどんなに不正なコードでも問題ない**ということです。

この原則自体は基本的に有用なものです。
実行バイナリには不要なコードが含まれず、また評価自体されないためコンパイル時間も削減できます。
しかし、ことテストに限ってはこの原則が邪魔をします。
実装した関数自体はまだ利用する箇所がないけれど、テストは実行したいという場合があるからです。

これに対処するため、Zig には `testing.refAllDecls()` という関数が用意されています。
この関数は、指定された型(Zigではファイルも型のようなものです)で定義されるフィールドを全て評価してくれます。
評価するということは、そこにあるテストも実行してくれるようになるということです。
ルートファイルである Ymir に以下を追加します:

```ymir/ymir.zig
testing {
    testing.refAllDeclsRecursive(@This());
}
```

`refAllDeclsRecursive()` を指定したため、`@This()`で定義される全てのフィールドに加え、
そのフィールドが参照するフィールドも再帰的に評価されます。
これにより、`bits.zig` にあるテストも実行されるようになります:

```bash
> zig build test --summary all
Build Summary: 3/3 steps succeeded; 4/4 tests passed
test success
└─ run Unit Test 2 passed 1ms MaxRSS:1M
   └─ zig test Unit Test Debug native success 1s MaxRSS:206M
```

今度は `2 passed` という表示になりました。ちゃんとテストが実行されています。

以上でユニットテストの実装および実行ができるようになりました。
`tobit()` 以外の2つの関数に対してもユニットテストを書いてみてください。
今後、本シリーズではユニットテストの実装については省略しますが、実際に開発する際には Zig のテスト機能を活用するのも良いかもしれません。
