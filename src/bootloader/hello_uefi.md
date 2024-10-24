# Hello UEFI

## Table of Contents

<!-- toc -->

## Hypervisor の種類

Hypervisor には大きく分けて Type-1 と Type-2 の2種類があります。

### Type-1 Hypervisor

Type-1 Hypervisor はベアメタルで動作する hypervisor です。
ハードウェアに直接アクセスできる一方、裏を返すと低レベルなリソース管理をする必要があります。
Type-2 と比較すると、より VM に特化したリソース管理ができたり、リソースアクセスの速度が早いという利点があります。
Type-1 に分類される主な hypervisor には以下のものがあります:

- VMWare ESXi
- Microsoft Hyper-V
- Linux KVM[^1]
- [BitVisor](https://www.bitvisor.org/)

### Type-2 Hypervisor

Type-2 Hypervisor はホストOS上で動作する hypervisor です。
ハードウェアリソースにアクセスする場合にはホストOSを経由する必要があるため、Type-1 に比べてオーバーヘッドが発生します。低レベルなリソース管理はOSに任せられるという観点では、Type-1 と比較して実装が容易であるとも言えます。

- Oracle VirtualBox
- VMWare Workstation
- QEMU

## Surtr Bootloader

本シリーズで実装する hypervisor は Type-1 です。ベアメタルで動きます。
そのため、必然的にOSが提供する機能を実装する必要があります。
本シリーズではゲストOSとして Linux を動かすことが最大の目的であるため、
一般的なOSが提供する機能を全て実装することはしませんが、以下のような基本的な機能は実装します:

- ブートローダ
- メモリ管理
- シリアル通信
- 割り込み

このうち、ブートローダの部分を **Surtr**[^2] と呼ぶことにします。
また、それ以外のカーネル部分を **Ymir**[^3] と呼びます。
本チャプターからは Surtr を実装して Ymir がブートするところまでをひとつの目標とします。

## UEFI アプリの作成

それでは早速 Surtr の実装を始めていきましょう。
Zig は UEFI プラットフォームを [Tier-2 サポート](https://ziglang.org/download/0.13.0/release-notes.html)しています。
そのため、普通のネイティブアプリをビルドするのと同様にして UEFI アプリを作成できます。

### ビルドスクリプトの設定

まずは Zig プロジェクトを作成します:

```sh
mkdir ymir && cd ymir
git init
zig init
```

以下のようなプロジェクト構成になります:

```txt
.
├── build.zig
├── build.zig.zon
└── src
    ├── main.zig
    └── root.zig
```

- `build.zig`[^4]: ビルドスクリプト。Zig ではプロジェクトのビルド設定自体を Zig で記述します。
- `build.zig.zon`: 依存関係を [ZON](https://zig.news/edyu/zig-package-manager-wtf-is-zon-558e) という形式で記述します。Surtr/Ymir は依存を全く持たないため、必要ありません。
- `src`: ソースディレクトリ。

本シリーズでは、デフォルトのプロジェクト構成から少し変更して以下のような構成にします:

```txt
.
├── build.zig
├── build.zig.zon
├── surtr
└── ymir
```

`src`の代わりに Surtr と Ymir 用のソースディレクトリをそれぞれ用意しています。
まずは`build.zig`に Surtr 用の設定を記述します:

```build.zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    // Surtr Executable
    const surtr = b.addExecutable(.{
        .name = "BOOTX64.EFI",
        .root_source_file = b.path("surtr/boot.zig"),
        .target = b.resolveTargetQuery(.{
            .cpu_arch = .x86_64,
            .os_tag = .uefi,
        }),
        .optimize = optimize,
        .linkage = .static,
    });
    b.installArtifact(surtr);
}
```

`b.standardOptimizeOption` はデフォルトの最適化オプションを取得する関数です。
最適化レベルはコマンドラインから指定でき、デフォルトでは `Debug` が設定されます。
利用可能な最適化レベルは以下の4つです:

- `Debug`: デフォルト。未定義動作(UD)に対するチェックが付与されます。
- `ReleaseFast`: 最もアグレッシブに最適化します。未定義動作(UD)に対するチェックが行われません。
- `ReleaseSafe`: 最適化を行いますが、未定義動作(UD)に対するチェックが付与されます。
- `ReleaseSmall`: 生成されるバイナリサイズが小さくなるように最適化します。

`b.addExecutable` で実行可能ファイルを追加します。
`.name`で出力名を指定します。
`.root_source_file`でエントリポイントとなるソースファイルを指定します。
**Zig では、Cのようにコンパイルするファイルやインクルードするファイルを全て指定する必要はありません**。
`.root_source_file`で指定したファイルから参照されるファイルを自動的にビルドツリーの中に含めてくれます。
`.target`にはコンパイルターゲットを指定します。
今回は x64 アーキテクチャの UEFI プラットフォームをターゲットとします。
ベアメタルで動くブートローダでありライブラリの動的ロードの仕組みは持っていないため、`.linkage`には`.static`を指定します。

最後に、`b.installArtifact()` で Surtr を `install` ターゲットに追加します。
Zig のビルドは `zig build <target>` コマンドで実行します。
この際、`<target>`を省略するとデフォルトのターゲットである `install` ターゲットが実行されます。
`installArtifact()`は、この `install` ターゲットに artifact を追加するものです。

<div class="warning">
.static のような記法について

`.static` は冗長に書くと `std.builtin.LinkMode.static` という `enum` の値です。
Zig では、関数の引数など値の型が確定している場合には `enum` の型を省略できます。
そのため、本シリーズでは多くのコードでFQDNを省略して記述しています。
(VSCode + ZLS でも、ピリオドをタイプした時点で可能な`enum`値が補完されます。)
</div>

### エントリポイントの作成

次に、`surtr/boot.zig` にエントリポイントを作成します:

```surtr/boot.zig
const std = @import("std");
const uefi = std.os.uefi;

pub fn main() uefi.Status {
    while (true)
        asm volatile ("hlt");

    return .success;
}
```

返り値の型は `std.os.uefi.Status` にします。`return`では、前述したようにFQDNを省略しています。
単純に`hlt`ループするだけの何もしないUEFIアプリです。

### QEMU で実行するための設定

この UEFI アプリを QEMU 上で実行します。
`build.zig`に以下の設定を追記します:

```build.zig
// EFI directory
const out_dir_name = "img";
const install_surtr = b.addInstallFile(
    surtr.getEmittedBin(),
    b.fmt("{s}/efi/boot/{s}", .{ out_dir_name, surtr.name }),
);
install_surtr.step.dependOn(&surtr.step);
b.getInstallStep().dependOn(&install_surtr.step);
```

Zig ではビルド生成物はデフォルトで `zig-out` というディレクトリに出力されます[^5]。
`addInstallFile()`によって、生成した `BOOTX64.EFI.efi` を `zig-out/img/efi/boot/BOOTX64.EFI` にコピーします。
`install_surtr.step.dependOn()`では、このコピー処理を行う前に Surtr のビルドを行うように依存関係を宣言しています。
また、続く `dependOn()` ではデフォルトの `install` ターゲットの依存としてこのコピー処理を実行するように宣言しています。
これにより、`zig build` したときに Surtr のビルドと生成物のコピー処理が行われるようになります。

続いて、QEMUを実行するための設定を追記します:

```build.zig
const qemu_args = [_][]const u8{
    "qemu-system-x86_64",
    "-m",
    "512M",
    "-bios",
    "/usr/share/ovmf/OVMF.fd",
    "-drive",
    b.fmt("file=fat:rw:{s}/{s},format=raw", .{ b.install_path, out_dir_name }),
    "-nographic",
    "-serial",
    "mon:stdio",
    "-no-reboot",
    "-enable-kvm",
    "-cpu",
    "host",
    "-s",
};
const qemu_cmd = b.addSystemCommand(&qemu_args);
qemu_cmd.step.dependOn(b.getInstallStep());

const run_qemu_cmd = b.step("run", "Run QEMU");
run_qemu_cmd.dependOn(&qemu_cmd.step);
```

QEMUに渡すオプションを指定しています。
オプションの意味は以下のとおりです:

- `-m 512M`: メモリを512MBに設定します。これより少なくても多くてもおそらく動きます。
- `-bios /usr/share/ovmf/OVMF.fd`: OVMFをFWとして指定します。
`apt`でインストールした場合にはこのパスになります。
自前でビルドした場合には、生成されたバイナリのパスを指定してください。
- `-drive file=...`: ハードドライブの設定をします。
QEMU では [VVFAT (Virtual FAT filesystem)](https://en.wikibooks.org/wiki/QEMU/Devices/Storage) という仮想ドライブによってホストのディレクトリをそのままゲストにドライブとして渡すことができるため、それを利用しています。
- `-nographic`: グラフィカルモードを無効にします。
- `-serial mon:stdio`: シリアル通信を標準入出力に設定します。
ターミナルからの入力はシリアル入力としてゲストに渡され、逆にシリアル出力はターミナルに出力されます。
- `-enable-kvm`: バックエンドに KVM を使用します。
- `-cpu host`: ホストのCPUをパススルーします。
- `-s`: GDB サーバを起動してポート`1234`でリッスンさせます。

`b.step()`によって、新しいビルドターゲットを追加しています。
これにより `zig build run` とすることで、その依存として設定した上記のQEMUコマンドが実行されます。

### 実行

それでは、実際にビルドして QEMU で実行してみましょう:

```sh
zig build run -Doptimize=Debug
```

以下のように、QEMU が起動し先に進まなければOKです:

```txt
BdsDxe: loading Boot0001 "UEFI QEMU HARDDISK QM00001 " from PciRoot(0x0)/Pci(0x1,0x1)/Ata(Primary,Master,0x0)
BdsDxe: starting Boot0001 "UEFI QEMU HARDDISK QM00001 " from PciRoot(0x0)/Pci(0x1,0x1)/Ata(Primary,Master,0x0)
```

`hlt`命令によってCPUが停止していることを確認してみましょう。
生成された UEFI アプリをディスアセンブルしてみると、`.text`セクションは以下のようになっています。とても小さいです:

```S
> objdump -D ./zig-out/img/efi/boot/BOOTX64.EFI | less

0000000000001000 <.text>:
    1000:       55                      push   rbp
    1001:       48 83 ec 30             sub    rsp,0x30
    1005:       48 8d 6c 24 30          lea    rbp,[rsp+0x30]
    100a:       48 89 4d f0             mov    QWORD PTR [rbp-0x10],rcx
    100e:       48 89 55 f8             mov    QWORD PTR [rbp-0x8],rdx
    1012:       48 89 0d e7 0f 00 00    mov    QWORD PTR [rip+0xfe7],rcx        # 0x2000
    1019:       48 89 15 e8 0f 00 00    mov    QWORD PTR [rip+0xfe8],rdx        # 0x2008
    1020:       e8 0b 00 00 00          call   0x1030
    1025:       48 83 c4 30             add    rsp,0x30
    1029:       5d                      pop    rbp
    102a:       c3                      ret
    102b:       0f 1f 44 00 00          nop    DWORD PTR [rax+rax*1+0x0]
    1030:       55                      push   rbp
    1031:       48 89 e5                mov    rbp,rsp
    1034:       eb 00                   jmp    0x1036
    1036:       f4                      hlt
    1037:       eb fd                   jmp    0x1036
```

`+1036`の位置に`hlt`命令が、`+1037`の位置に`hlt`にジャンプするコードがあります。
続いて、QEMU の起動中に `Ctrl+A C` をタイプして QEMU monitor を起動させ、レジスタの値を見てみます:

```txt
BdsDxe: loading Boot0001 "UEFI QEMU HARDDISK QM00001 " from PciRoot(0x0)/Pci(0x1,0x1)/Ata(Primary,Master,0x0)
BdsDxe: starting Boot0001 "UEFI QEMU HARDDISK QM00001 " from PciRoot(0x0)/Pci(0x1,0x1)/Ata(Primary,Master,0x0)
QEMU 8.2.2 monitor - type 'help' for more information
(qemu) info registers

CPU#0
RAX=000000001e32dc18 RBX=0000000000000000 RCX=000000001ed7a298 RDX=000000001f9ec018
RSI=0000000000000000 RDI=000000001e32dc18 RBP=000000001fe967d0 RSP=000000001fe967d0
R8 =00000000000000af R9 =0000000000000400 R10=000000001feb1258 R11=000000001feae6b0
R12=0000000000000000 R13=000000001ed8d000 R14=0000000000000000 R15=000000001feafa20
RIP=000000001e235037 RFL=00000202 [-------] CPL=0 II=0 A20=1 SMM=0 HLT=1
ES =0030 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
CS =0038 0000000000000000 ffffffff 00a09b00 DPL=0 CS64 [-RA]
SS =0030 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
DS =0030 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
FS =0030 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
GS =0030 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
LDT=0000 0000000000000000 0000ffff 00008200 DPL=0 LDT
TR =0000 0000000000000000 0000ffff 00008b00 DPL=0 TSS64-busy
GDT=     000000001f9dc000 00000047
IDT=     000000001f537018 00000fff
CR0=80010033 CR2=0000000000000000 CR3=000000001fc01000 CR4=00000668
...
```

RIP が `000000001e235037` になっていることがわかります。
下 3nibble が先程見たアセンブリの `jmp` 命令のアドレスと一致しているため、意図したとおりにループされていることがわかりますね。
(このアプリがロードされたベースアドレスがどうやら `0x1E235000` だったようですね。)

<div class="warning">
レジスタ値からわかること

`info registers`の結果からだけでも、いくつかのことが分かります。
例えば、UEFI がGDTやIDTの設定は既にしてくれているようです。
また、CR3 が設定されていることからも UEFI が 64-bit モードを有効化してくれているようです。
そのことから、現在のページテーブルは仮想アドレスと物理アドレスがダイレクトマップされているであろうことが推測できます。
気になる人は CR3 を辿ってページテーブルを探索してみるのも良いかもしれません。
自力でやらずとも、GDB拡張である [gef](https://github.com/bata24/gef) の `vmmap` コマンドを使うと簡単にメモリマップを一覧できます。
</div>

## References

- [ssstoyama/bootloader_zig](https://github.com/ssstoyama/bootloader_zig)
- [フルスクラッチで作る!UEFIベアメタルプログラミング](http://yuma.ohgami.jp/UEFI-Bare-Metal-Programming/index.html)
- [bata24/gef](https://github.com/bata24/gef)

[^1]: KVM はホストOSである Linux とやり取りするため一見すると Type-2 のようにも思えますが、
Linuxと同じ最低レイヤで動作するということを考えれば、Type-1 に分類されることが多いのも納得ですね。
[^2]: Surtr は北欧神話における火の巨人です。
神話中でも多くは語られず、最終戦争であるラグナロクの際に暴れまわって世界を滅ぼすくらいしか登場しません。
原初の巨人である Ymir よりも先に存在していたという不思議な存在です。
Ymir よりも先に存在していたという理由でブートローダの名前に採用しています。
[^3]: Ymir は北欧神話における原初の巨人です。
世界が生まれる前に溶けた霜から生まれ、一緒に生まれたアウズンブラという牛の乳を飲んで育ちます。
全能神であるオーディンは Ymir の子孫にあたりますが、Ymir はオーディンによって殺されてその死骸から世界が作られました。
原初の存在であり Ymir から世界が生まれたという言い伝えから、ゲストOSをホストする hypervisor (のカーネル部分)の名前に採用しています。
[^4]: [Zig Build System](https://ziglang.org/learn/build-system/)
[^5]: コマンドラインオプションから出力ディレクトリはオーバーライドできます。
