# シリアルログシステム

[シリアル出力](serial_output.md) ではシリアルポートに対して出力ができるようになりました。
本チャプターでは、このシリアル出力を用いてログシステムを実装します。
基本的には [Surtr の ログ出力](../bootloader/uefi_log.md) でやったことと同じになります。
そのため、本チャプターは一瞬で終わります。やったね、今日は早く寝てください。

## Table of Contents

<!-- toc -->

## デフォルトログのオーバーライド

まずは、必要な構造体や関数を一気に定義してしまいます:

```ymir/log.zig
const Writer = std.io.Writer(
    void,
    LogError,
    write,
);

pub const default_log_options = std.Options{
    .log_level = switch (option.log_level) {
        .debug => .debug,
        .info => .info,
        .warn => .warn,
        .err => .err,
    },
    .logFn = log,
};

fn log(
    comptime level: stdlog.Level,
    comptime scope: @Type(.EnumLiteral),
    comptime fmt: []const u8,
    args: anytype,
) void {
    const level_str = comptime switch (level) {
        .debug => "[DEBUG]",
        .info => "[INFO ]",
        .warn => "[WARN ]",
        .err => "[ERROR]",
    };

    const scope_str = if (@tagName(scope).len <= 7) b: {
        break :b std.fmt.comptimePrint("{s: <7} | ", .{@tagName(scope)});
    } else b: {
        break :b std.fmt.comptimePrint("{s: <7}-| ", .{@tagName(scope)[0..7]});
    };

    std.fmt.format(
        Writer{ .context = {} },
        level_str ++ " " ++ scope_str ++ fmt ++ "\n",
        args,
    ) catch {};
}
```

Surtr のときと同様に、デフォルトの `std_options` をオーバーライドするための `default_log_options` を定義します。
`log_level` はビルド時に指定できるようにし、`logFn` には `log` 関数を指定します。
`log()` は本当に Surtr と同じです。
強いて言えば、スコープ文字列の最大長を7文字に制限しています。
7文字以下の場合はスペースで埋め、7文字以上の場合は `-` で省略します。

`option` モジュールを使えるように `build.zig` に以下を追加します:

```zig
ymir_module.addOptions("option", options);
ymir.root_module.addOptions("option", options);
```

`main.zig` から `ymir/log.zig` を使えるように、`ymir/ymir.zig` から export します。
この際、`log` という名前で export すると `std.log` と混同してしまうおそれがあるため、`klog` として export します:

```ymir/ymir.zig
pub const klog = @import("log.zig");
```

定義した `default_log_options` を使って、デフォルトの値を上書きします:

```ymir/main.zig
const klog = ymir.klog;
pub const std_options = klog.default_log_options;
```

## シリアルの初期化と利用

このログシステムは出力を完全にシリアルに依存しています。
そのため、このログシステムを利用する前にシリアルを初期化し、その後ログシステムに `Serial` を渡して初期化する必要があります:

```ymir/main.zig
const sr = serial.init();
klog.init(sr);
log.info("Booting Ymir...", .{});
```

渡された `Serial` は `log.zig` の変数に保存し、出力時に利用します:

```ymir/log.zig
var serial: Serial = undefined;

pub fn init(ser: Serial) void {
    serial = ser;
}

fn write(_: void, bytes: []const u8) LogError!usize {
    serial.writeString(bytes);
    return bytes.len;
}
```

## アウトロ

以上でシリアル出力を用いたログの用意は完了です。
以降は全てのファイルに置いて `std.log.info()` のようにしてシリアルログ出力ができます。
`ymir/log.zig` を import する必要はありません。楽ですね。

[カーネルの起動](../bootloader/jump_to_ymir.md) では Surtr からの引数である `BootInfo` を検証しました。
その時点ではログシステムを用意していなかったため、検証に失敗しても無言で return していました。
ログが使えるようになったので、以下のようにエラー出力をできるようにしておきましょう:

```ymir/main.zig
validateBootInfo(boot_info) catch {
    log.err("Invalid boot info", .{});
    return error.InvalidBootInfo;
};
```
