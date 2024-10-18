# カーネルのELFをパースする

本チャプターでは、ホストOSである Ymir を UEFI のファイルシステムから読み込み、
その ELF ファイルをパースして必要とされるメモリレイアウトを取得します。
本来であればそのままメモリに Ymir をロードして処理を移したいところですが、
そのためには ELF が要求する仮想アドレスに物理ページをマップするためのページテーブルを作成する必要があります。
ページテーブルは次チャプターであとまわしにして、今回は ELF のパースまでを行います。

## Table of Contents

<!-- toc -->

## Ymir の雛形のビルド

カーネルである Ymir をロードするためには、当然 Ymir の ELF ファイルをビルドする必要があります。
まずは何もしない Ymir の雛形を作成し、その ELF ファイルをビルドできるようにします。

`ymir` ディレクトリを作成し、`ymir/main.zig` を以下のようにします:

```zig
// -- ymir/main.zig --

export fn kernelEntry() callconv(.Naked) noreturn {
    while (true)
        asm volatile ("hlt");
}
```

`kernelEntry()` は Surtr から処理が移される Ymir のエントリポイントとします。
この関数からは抜け出すことがないため、返り値の型は `noreturn` とします。

Zig では `callconv()` によって関数の [calling convention](https://en.wikipedia.org/wiki/Calling_convention) を指定できます。
[UEFI の calling convention](https://uefi.org/specs/UEFI/2.9_A/02_Overview.html#calling-conventions) は Windows と同じであるため本来は `.Win64` を指定するべきです。
しかし、後々この関数はスタックをカーネル用に切り替えて実際のメイン関数を呼び出すためのトランポリン関数にする予定のため、
ここでは一旦 `.Naked` を指定しておきます。
この calling convention は関数のプロローグやエピローグを生成せずレジスタ状態の変更も伴わないため、
トランポリンコードには最適です。

これで Ymir の雛形ができたので、ビルドの設定をします:

```zig
// -- build.zig --

const ymir_target = b.resolveTargetQuery(.{
    .cpu_arch = .x86_64,
    .os_tag = .freestanding,
    .ofmt = .elf,
});
const ymir = b.addExecutable(.{
    .name = "ymir.elf",
    .root_source_file = b.path("ymir/main.zig"),
    .target = ymir_target, // Freestanding x64 ELF executable
    .optimize = optimize, // You can choose the optimization level.
    .linkage = .static,
    .code_model = .kernel,
});
ymir.entry = .{ .symbol_name = "kernelEntry" };
b.installArtifact(ymir);
```

`.target` ではOSタグとして `.freestanding` を指定します。
また、`.code_model`でコードモデル[^1]として `.kernel` を指定します。
コードモデルはリロケーションに必要な情報を生成するために参照され、他には `.small` や `.medium` などがあります。
のちのチャプターで出てきますが Ymir のアドレスレイアウトは Linux に似せて `0xFFFF888000000000` らへんに配置するようにします。
そのため、 `.kernel` を指定しないとリロケーションに必要な情報が入り切らずエラーになってしまいます。
アドレスレイアウトを指定するにはリンカスクリプトを書く必要がありますが、今のところはこのままで問題ありません。
最後に、エントリポイントとして先程定義した `kernelEntry()` を指定してあげれば完成です。

この時点で `zig build` を実行すると `zig-out/bin/ymir.elf` が生成されます。
`readelf`でヘッダを見てみましょう:

```sh
> readelf -h ./zig-out/bin/ymir.elf

ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF64
  Data:                              2's complement, little endian
  Version:                           1 (current)
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              EXEC (Executable file)
  Machine:                           Advanced Micro Devices X86-64
  Version:                           0x1
  Entry point address:               0x1001120
  Start of program headers:          64 (bytes into file)
  Start of section headers:          5216 (bytes into file)
  Flags:                             0x0
  Size of this header:               64 (bytes)
  Size of program headers:           56 (bytes)
  Number of program headers:         4
  Size of section headers:           64 (bytes)
  Number of section headers:         13
  Section header string table index: 11
```

当然ですがちゃんと 64bit ELF が生成されています。
エントリポイントは `0x1001120` であり、`objdump` で周辺を見てみると先程定義した `kernelEntry()` が存在していることがわかります:

```sh
> objdump -D ./zig-out/bin/ymir.elf | grep 1001120 -n3

7:0000000001001120 <kernelEntry>:
8: 1001120:     f4                      hlt
9: 1001121:     eb fd                   jmp    1001120 <kernelEntry>
```

以上で Surtr から読み込むための Ymir の ELF ファイルが生成できました。
生成した Ymir を EFI ファイルシステムに配置する設定も書いてしまいましょう:

```zig
// -- build.zig --

const install_ymir = b.addInstallFile(
    ymir.getEmittedBin(),
    b.fmt("{s}/{s}", .{ out_dir_name, ymir.name }),
);
install_ymir.step.dependOn(&ymir.step);
b.getInstallStep().dependOn(&install_ymir.step);
```

[Surtr をインストールする設定](hello_uefi.md)とほとんど同じです。
これにより、Ymir は `zig-out/img/ymir.elf` に配置されることになります。

## カーネルヘッダの読み込み

Surtr からファイルシステム上のファイルにアクセスするためには [Simple File System Protocol](https://uefi.org/specs/UEFI/2.10/13_Protocols_Media_Access.html#simple-file-system-protocol) を使います。
Surtr が実行されてから明示的に exit するまでは、 [Boot Services](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html) という UEFI が提供する関数群にアクセスできます。
Boot Services へのポインタは、前回ログ出力に利用した Simple Text Output Protocol と同様に [EFI System Table](https://uefi.org/specs/UEFI/2.9_A/04_EFI_System_Table.html#efi-system-table-1) から取得できます:

```zig
// -- src/boot.zig --

const boot_service: *uefi.tables.BootServices = uefi.system_table.boot_services orelse {
    log.err("Failed to get boot services.", .{});
    return .Aborted;
};
log.info("Got boot services.", .{});
```

取得した Boot Services から、Simple File System Protocol を取得します:

```zig
// -- src/boot.zig --

var fs: *uefi.protocol.SimpleFileSystem = undefined;
status = boot_service.locateProtocol(&uefi.protocol.SimpleFileSystem.guid, null, @ptrCast(&fs));
if (status != .Success) {
    log.err("Failed to locate simple file system protocol.", .{});
    return status;
}
log.info("Located simple file system protocol.", .{});
```

続いて、Simple File System Protocol を利用して FS のルートディレクトリを開きます:

```zig
// -- src/boot.zig --
var root_dir: *uefi.protocol.File = undefined;
status = fs.openVolume(&root_dir);
if (status != .Success) {
    log.err("Failed to open volume.", .{});
    return status;
}
log.info("Opened filesystem volume.", .{});
```

### ファイルのオープン

続いて、Ymir の ELF ファイルを開きます。
ファイルを開くのには [open()](https://uefi.org/specs/UEFI/2.10/13_Protocols_Media_Access.html#id25) 関数を使います。
ここで指定するファイル名は、前回のログ出力と同様に [UCS-2](https://e-words.jp/w/UCS-2.html) を使う必要があります。
Simple File System Protocol を利用してファイルを開く機会は他にもいくつかあるため、UCS-2 への変換をする関数を用意してあげましょう:

```zig
// -- src/boot.zig --

inline fn toUcs2(comptime s: [:0]const u8) [s.len * 2:0]u16 {
    var ucs2: [s.len * 2:0]u16 = [_:0]u16{0} ** (s.len * 2);
    for (s, 0..) |c, i| {
        ucs2[i] = c;
        ucs2[i + 1] = 0;
    }
    return ucs2;
}
```

開くファイル名はコンパイル時に決まっているため、引数は `comptime s` としています。
このようにすると、返り値の型として `s.len` のような情報が使えるようになります。
今回は UCS-2 に変換するとバイト長が2倍になるため、返り値の方は `[s.len * 2:0]u16` です。
関数内でやっていることは前回と同様に ASCII 文字列の各バイトの後に `\0` を加えているだけです。

この関数を利用して、ファイルを開く関数を作ります:

```zig
// -- src/boot.zig --

fn openFile(
    root: *uefi.protocol.File,
    comptime name: [:0]const u8,
) !*uefi.protocol.File {
    var file: *uefi.protocol.File = undefined;
    const status = root.open(
        &file,
        &toUcs2(name),
        uefi.protocol.File.efi_file_mode_read,
        0,
    );

    if (status != .Success) {
        log.err("Failed to open file: {s}", .{name});
        return error.Aborted;
    }
    return file;
}
```

`root.open()` で実際にファイルをオープンします。
第3引数にはファイルのモードを選択します。書き込む必要がないため RO で十分です。
第4引数はファイル作成時に作成するファイルの attribute を指定しますが、今回はオープンしかしないため使いません。
適当に `0` を指定しておきます。

この関数を使うと、カーネルを以下のようにオープンできます:

```zig
// -- src/boot.zig --

const kernel = openFile(root_dir, "ymir.elf") catch return .Aborted;
log.info("Opened kernel file.", .{});
```

### ファイルの読み込み

Ymir の ELF がオープンできたため実際にファイルをリードします。
ELF ファイルは必ず [ELF Header](https://refspecs.linuxfoundation.org/elf/gabi4+/ch4.eheader.html) というヘッダから始まります。
まずはこのヘッダだけを読み込んでパースしていきます。

ファイルを読み込むための領域は Boot Services が提供する [Memory Allocation Services](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-allocation-services) の [AllocatePool()](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#id16) 関数を利用します:

```zig
// -- src/boot.zig --

var header_size: usize = @sizeOf(elf.Elf64_Ehdr);
var header_buffer: [*]align(8) u8 = undefined;
status = boot_service.allocatePool(.LoaderData, header_size, &header_buffer);
if (status != .Success) {
    log.err("Failed to allocate memory for kernel ELF header.", .{});
    return status;
}
```

`allocatePool()`の第1引数には確保するメモリタイプ[^2]を指定します。
今回は `LoaderData` という UEFI アプリのデータ用のメモリ[^3]を取得します。
ELF ヘッダのサイズは固定であり、`std.elf.Elf64_Ehdr` 構造体のサイズと同一です。
このサイズ分だけメモリを確保しています。

読み込み用メモリを確保したので、実際にファイルを読み込みます:

```zig
// -- src/boot.zig --

status = kernel.read(&header_size, header_buffer);
if (status != .Success) {
    log.err("Failed to read kernel ELF header.", .{});
    return status;
}
```

ここまでで Ymir カーネルの ELF ヘッダを読み込むことができました。
実際にQEMU上で実行して正常に動作していることを確認してみてください。

## ELF ヘッダのパース

最後に、読み込んだ ELF ヘッダのパースをします。
ELF ヘッダの構造はとてもシンプルなためパーサを自分で書いてもいいですが、
Zig は先程見たように ELF ヘッダを表現する構造体 `std.elf.Elf64_Ehdr` を提供してます。
今回はこれを使うことにします[^4]:

```zig
// -- src/boot.zig --

const elf_header = elf.Header.parse(header_buffer[0..@sizeOf(elf.Elf64_Ehdr)]) catch |err| {
    log.err("Failed to parse kernel ELF header: {?}", .{err});
    return .Aborted;
};
log.info("Parsed kernel ELF header.", .{});
```

たったこれだけです。簡単ですね。
本当に正しくパースできているのかどうかを確認するため、一部のフィールドを出力してみましょう:

```zig
log.debug(
    \\Kernel ELF information:
    \\  Entry Point         : 0x{X}
    \\  Is 64-bit           : {d}
    \\  # of Program Headers: {d}
    \\  # of Section Headers: {d}
,
    .{
        elf_header.entry,
        @intFromBool(elf_header.is_64),
        elf_header.phnum,
        elf_header.shnum,
    },
);
```

出力結果は以下のようになります:

```txt
[INFO ] (surtr): Initialized bootloader log.
[INFO ] (surtr): Got boot services.
[INFO ] (surtr): Located simple file system protocol.
[INFO ] (surtr): Opened filesystem volume.
[INFO ] (surtr): Opened kernel file.
[INFO ] (surtr): Parsed kernel ELF header.
[DEBUG] (surtr): Kernel ELF information:
  Entry Point         : 0x10012B0
  Is 64-bit           : 1
  # of Program Headers: 4
  # of Section Headers: 16
```

これらの値が正しいのかどうかは、 `zig-out/bin/ymir.elf` のヘッダを `readelf -h`で見た結果と比較することで確認できます。

ここまでで Ymir のヘッダをパースできました。
このあとは ELF のプログラムヘッダをパースし、各セグメントを ELF が要求する仮想アドレスにロードしてあげる必要があります。
しかし、要求された仮想アドレスを物理アドレスにマップするにはページテーブルを設定する必要があります。
次チャプターでは、ページテーブルの設定をします。

[^1]: [Understanding the x64 code models - Eli Bendersky's website](https://eli.thegreenplace.net/2012/01/03/understanding-the-x64-code-models)
[^2]: [Memory Type Usage before ExitBootServices() - UEFI Specification 2.9A](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#memory-type-usage-before-exitbootservices)
[^3]: `LoaderData` は UEFI アプリのデフォルトのメモリタイプでもあります。
[^4]: Surtr/Ymir は外部依存パッケージを一切持ちません。しかし、Zig が提供するものは使っています。それすらも使いたくない場合には、ぜひ自分で ELF パーサも書いてみてください。結構勉強になると思います。
