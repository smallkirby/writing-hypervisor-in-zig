# VMCALL Service

本チャプターは、Writing Hypervisor in Zig におけるとりあえずの最終章です。
今後も気が向いたら加筆される可能性はありますが、一旦本チャプターを持って締めくくろうと思います。
本チャプターはエクストラステージとして、VMCALL を使った VMCALL Service を実装します。
かなりコンパクトなチャプターです。
VMCALL Service を活用することで、ゲストがホストに対して何らかの要求をしたり、逆にホストがゲストの情報を取得することができるようになります。
本チャプターではそれらを実装するための基盤を作ります。

> [!IMPORTANT]
>
> 本チャプターの最終コードは [`whiz-vmm-vmcall`](https://github.com/smallkirby/ymir/tree/whiz-vmm-vmcall) ブランチにあります。

## Table of Contents

<!-- toc -->

## VMCALL 概要

[VMCALL](https://www.felixcloutier.com/x86/vmcall) はゲストから VMM の機能を呼び出すための命令です。
VMM の機能を呼び出すとは言ったものの、**この命令は VM Exit を発生させる以外には何もしません**。
VMCALL による VM Exit は、Basic Reason が `VMCALL(18)` となります。
VM Exit したあとに何をするかは完全に VMM の実装依存です。

Ymir ではお試しとして VMCALL サービスを1つだけ提供します。
この VMCALL が呼び出されると、Ymir はロゴとメッセージをシリアル出力するようにします。

> [!NOTE]
>
> VMCALL は VMX 拡張命令であり、VMX Operation でない場合に呼び出すと `#UD: Invalid Opcode` 例外が発生します。
> セキュリティ的な理由でゲストにゲスト自身が仮想化されていることを隠したい場合には、この挙動を真似て VMCALL の呼び出し時に `#UD` 例外を発生させる必要があります。
> 例外の挿入は [割り込みの注入のチャプター](./intr_injection.md) で扱ったように VM-Entry Interruption-Information を設定することで可能です。

## VMCALL Service の実装

VMCALL サービスを定義していきます。
VMCALL は命令自体は引数も何も持たず、calling convention を VMM 側で定義する必要があります。
Ymir では **RAX に VMCALL Service の番号を入れて呼び出すという規約** にします。
VMCALL Service の `0` には `hello` という名前をつけて、ロゴとメッセージを出力するようにします:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vmc.zig
const VmcallNr = enum(u64) {
    hello = 0,

    _,
};

pub fn handleVmcall(vcpu: *Vcpu) VmxError!void {
    const rax = vcpu.guest_regs.rax;
    const nr: VmcallNr = @enumFromInt(rax);

    switch (nr) {
        .hello => try vmcHello(vcpu),
        _ => log.err("Unhandled VMCALL: nr={d}", .{rax}),
    }
}
```

`vmcHello()` はロゴを出力するだけの簡単な関数です。
ここでは [Text to ASCII Art Generator (TAAG)](https://patorjk.com/software/taag/#p=display&f=Flower%20Power&t=) で生成したロゴを使います:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vmc.zig
const logo =
    \\   ____     __ ,---.    ,---..-./`) .-------.
    \\   \   \   /  /|    \  /    |\ .-.')|  _ _   \
    \\    \  _. /  ' |  ,  \/  ,  |/ `-' \| ( ' )  |
    \\     _( )_ .'  |  |\_   /|  | `-'`"`|(_ o _) /
    \\ ___(_ o _)'   |  _( )_/ |  | .---. | (_,_).' __
    \\|   |(_,_)'    | (_ o _) |  | |   | |  |\ \  |  |
    \\|   `-'  /     |  (_,_)  |  | |   | |  | \ `'   /
    \\ \      /      |  |      |  | |   | |  |  \    /
    \\  `-..-'       '--'      '--' '---' ''-'   `'-'
;

fn vmcHello(_: *Vcpu) VmxError!void {
    log.info("GREETINGS FROM VMX-ROOT...\n{s}\n", .{logo});
    log.info("This OS is hypervisored by Ymir.\n", .{});
}
```

## ymirsh

最後に、VMCALL を呼び出すためのユーザランドプログラムを実装します。
*Writing Hypervisor in Zig* で書く最後のプログラムがユーザランドというのはなんともまた皮肉な話です。
新しく `ymirsh` というディレクトリを作成し、VMCALL をするだけのプログラムを書きます:

<!-- i18n:skip -->
```ymirsh/main.zig
fn asmVmcall(nr: u64) void {
    asm volatile (
        \\movq %[nr], %%rax
        \\vmcall
        :
        : [nr] "rax" (nr),
        : "memory"
    );
}

pub fn main() !void {
    asmVmcall(0);
}
```

先ほど決めたように、VMCALL Service の番号は RAX に入れて呼び出します。
それ以外は何もしません。

`build.zig` に `ymirsh` をビルドするための設定を追記します。
これまで書いてきた Surtr や Ymir とは異なり、`ymirsh` はユーザランドプログラムなので `.os_tag = .linux` を指定します:

<!-- i18n:skip -->
```build.zig
const ymirsh = b.addExecutable(.{
    .name = "ymirsh",
    .root_source_file = b.path("ymirsh/main.zig"),
    .target = b.resolveTargetQuery(.{
        .cpu_arch = .x86_64,
        .os_tag = .linux,
        .cpu_model = .baseline,
    }),
    .optimize = optimize,
    .linkage = .static,
});
ymirsh.root_module.addOptions("option", options);
b.installArtifact(ymirsh);
```

`zig build install` でビルドすると `zig-out/bin/ymirsh` が生成されます。
これを `rootfs.cpio.gz` の中の FS における `/bin` 以下に配置してあげれば準備は完了です。

## まとめ

以上で VMCALL Service の実装は終了です。
最後にゲスト及び `ymirsh` を実行してみましょう:

<!-- i18n:skip -->
```txt
[    0.398950] mount (43) used greatest stack depth: 13832 bytes left
[    0.400950] ln (52) used greatest stack depth: 13824 bytes left
Starting syslogd: OK
Starting klogd: OK
Running sysctl: OK
Saving 256 bits of non-creditable seed for next boot
/bin/sh: can't access tty; job control turned off
~ # ./bin/ymirsh
[INFO ] vmc     | GREETINGS FROM VMX-ROOT...
   ____     __ ,---.    ,---..-./`) .-------.
   \   \   /  /|    \  /    |\ .-.')|  _ _   \
    \  _. /  ' |  ,  \/  ,  |/ `-' \| ( ' )  |
     _( )_ .'  |  |\_   /|  | `-'`"`|(_ o _) /
 ___(_ o _)'   |  _( )_/ |  | .---. | (_,_).' __
|   |(_,_)'    | (_ o _) |  | |   | |  |\ \  |  |
|   `-'  /     |  (_,_)  |  | |   | |  | \ `'   /
 \      /      |  |      |  | |   | |  |  \    /
  `-..-'       '--'      '--' '---' ''-'   `'-'

[INFO ] vmc     | This OS is hypervisored by Ymir.
```

`ymirsh` が VMCALL を実行すると、サービス0番の `hello` が呼び出されてロゴとメッセージが出力されました。
今まで Ymir がしてきたログ出力と見た目はなんら変わりませんが、このログはゲストに明示的に要求されて出力されているという違いがあります。

本チャプターでは VMCALL Service の実装をしました。
実装した機能はログ出力をするだけのほぼ意味がないものでしたが、この枠組みを利用してゲストとホストの間でさまざまなやり取りをすることができます。
たとえば [BitVisor](https://www.bitvisor.org/) では `dbgsh` というプログラムが VMCALL を介して VMM と対話的にやりとりをするシェルを提供しています。
他には、起動時に VMCALL を使って Linux カーネルにおける保護したいメモリアドレスを VMM に通知し、そのアドレスを EPT を使って保護するといった使い方もできます。
基本的にメモリの保護はカーネル自身がページテーブルを使って行えますが、カーネル自体が攻撃者に掌握された場合にはカーネルのセキュリティ機構は意味をなさなくなってしまいます。
そこで、起動時に一度だけ VMM に保護対象のアドレスを通知することで、カーネルが陥落しても VMM が指定されたメモリを保護することができます。
といったように、VMCALL は使い方次第でいろいろなことが実現できます。
ぜひ自分なりのアイデアを実装してみてください。

さて、以上で **Writing Hypervisor in Zig** は終了です。
もしもここまで読んでくださった方がいるのであれば、ありがとうございます。
実装してきた Ymir は、依然としておもちゃの域を超えていません。
[トップページ](../intro.md) に書いたように、いろいろな機能が未実装のままです。
しかしながら、Linux をブートできたという事実には変わりありません。
Ymir をベースとして、もしくは全てゼロからフルスクラッチで、さらに自分なりの機能を追加してみてください。
その際の足がかりとして Ymir というおもちゃが役立てば幸いです。
