# カーネルの起動

UEFI にいる状態でするべきお片付けも終わったため、いよいよカーネルを起動する準備ができました。
本チャプターでは、カーネルに渡す引数を準備して Ymir カーネルへジャンプします。
ジャンプした先でスタックのピボットをして用意しておいたカーネルスタックに切り替えたあと、カーネルのメイン関数に制御を移します。

## Table of Contents

<!-- toc -->

## カーネルに渡す引数の準備

Surtr から Ymir にはいくつかの情報を渡す必要があります。
その代表的なものは、UEFI から取得したメモリマップです。
Boot Services を exit したあとではこのメモリマップを取得する方法がなくなるため、
Surtr が事前に取得しておいたメモリマップを Ymir に渡します。

`surtr/defs.zig`  に Surtr/Ymir 間で受け渡しする情報を定義します:

```surtr/defs.zig
pub const magic: usize = 0xDEADBEEF_CAFEBABE;

pub const BootInfo = extern struct {
    /// Magic number to check if the boot info is valid.
    magic: usize = magic,
    /// UEFI memory map.
    memory_map: MemoryMap,
};
```

`magic` は、正しく引数を Ymir に渡せたことを確認するためのマジックナンバーです。
`memory_map` は Boot Services から取得した現在のメモリマップです。
Ymir はこのマップをもとにして不要な UEFI の領域を解放し、独自のメモリアロケータを構築します。

この `boot.zig` において `BootInfo` を作成します:

```surtr/boot.zig
const boot_info = defs.BootInfo{
    .magic = defs.magic,
    .memory_map = map,
};
```

なお、既に Boot Services を exit してしまっているため、デバッグのためにログ出力は使えないことに注意してください。

## カーネルへのジャンプ

いよいよカーネルへとジャンプします。
このジャンプは、通常の関数呼び出しと同じ方法で実現できます。
カーネルのエントリポイントは、先程の `BootInfo` を受け取る関数です。
UEFI の calling convention は Windows と同じ[^1]であるため、`callconv(.Win64)` を指定します:

```surtr/boot.zig
const KernelEntryType = fn (defs.BootInfo) callconv(.Win64) noreturn;
const kernel_entry: *KernelEntryType = @ptrFromInt(elf_header.entry);
```

エントリポイントのアドレスは、ELF ヘッダにある `entry` フィールドに書いてあります。
この値を `@ptrFromInt()` を使って `*KernelEntryType` という関数ポインタにキャストします。

残るは、この関数ポインタを呼び出すだけです:

```surtr/boot.zig
kernel_entry(boot_info);
unreachable;
```

Ymir に処理が移ったあとは Surtr に戻ることはありません。

さて、実際に動かして Ymir が実行されていることを確認しましょう。
現在 Ymir のエントリポイントである `kernelEntry()` は無限 halt するだけの関数です。
QEMU を動かして無限ループで止まることを確認してください。
その状態で QEMU monitor を起動し、`info registers` でレジスタの値を確認してみましょう:

```txt
(qemu) info registers

CPU#0
RAX=deadbeefcafebabe RBX=000000001fe93750 RCX=000000001fe91f78 RDX=0000000000000000
RSI=0000000000000030 RDI=000000001fe91ef8 RBP=000000001fe908a0 RSP=000000001fe8fff8
R8 =000000001fe8ff8c R9 =000000001f9ec018 R10=000000001fae6880 R11=0000000089f90beb
R12=000000001feaff40 R13=000000001fe93720 R14=00000000feffc000 R15=00000000ff000000
RIP=ffffffff80100001 RFL=00000046 [---Z-P-] CPL=0 II=0 A20=1 SMM=0 HLT=1
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
CR0=80010033 CR2=0000000000000000 CR3=000000001e4d9000 CR4=00000668
```

`RIP` は `0xFFFFFFFF80100001` となっており、これは Ymir のリンカスクリプトで指定した `.text` セクションの値です。
正しく Ymir に実行が移ったようですね！

Windows における calling convention では、引数は RCX, RDX, R8, R9 に順に入れられます。
今回は引数は `BootInfo` の1つだけなので、RCX に `BootInfo` のアドレスが入っているはずです:

```txt
(qemu) x/4gx 0x000000001fe91f78
000000001fe91f78: 0xdeadbeefcafebabe 0x0000000000004000
000000001fe91f88: 0x000000001fe91fb0 0x0000000000001770
```

RCX が指す先には、`BootInfo` の先頭フィールドである `magic` の値 `0xDEADBEEFCAFEBABE` が入っていることが確認できます。
引数の受け渡しもしっかりできているようです。

## リンカスクリプトとスタック

カーネルが起動したものの、依然としていろいろなものを UEFI が用意してくれたまま使っています。
IDT や GDT などもそうですが、最初に重要なのがスタックです。

UEFI が Surtr を実行する際にはスタックを用意してくれるのですが、このスタック領域は `BootServiceData` と呼ばれるブート用の領域に確保されています。
この領域はのちほど Ymir が自身のメモリアロケータを初期化する際に解放することになります。
よって、まずは**スタックをカーネル用の領域へと切り替える必要があります**。
今回は、Ymir にスタック用のセグメントを用意してあげることでスタック領域を用意することにします[^2]。

### レイアウトの設定

[カーネルのロードのチャプター](load_kernel.md) で Ymir のレイアウトをリンカスクリプトで簡単に設定しました。
ここではもう少しだけ真面目に設定します。
`ymir/linker.ld` を以下のように書き換えます[^3]:

```ymir/linker.ld
STACK_SIZE = 0x5000;

SECTIONS {
    . = KERNEL_VADDR_TEXT;

    .text ALIGN(4K) : AT (ADDR(.text) - KERNEL_VADDR_BASE) {
        *(.text)
        *(.ltext)
    } :text

    .rodata ALIGN(4K) : AT (ADDR(.rodata) - KERNEL_VADDR_BASE) {
        *(.rodata)
    } :rodata

    .data ALIGN(4K) : AT (ADDR(.data) - KERNEL_VADDR_BASE) {
        *(.data)
    } :data

    .bss ALIGN(4K) : AT (ADDR(.bss) - KERNEL_VADDR_BASE) {
        *(COMMON)
        *(.bss)
    } :bss

    __stackguard_upper ALIGN(4K) (NOLOAD) : AT (ADDR(__stackguard_upper) - KERNEL_VADDR_BASE) {
        . += 4K;
    } :__stackguard_upper

    __stack ALIGN(4K) (NOLOAD) : AT (ADDR(__stack) - KERNEL_VADDR_BASE) {
        . += STACK_SIZE;
    } :__stack

    __stackguard_lower ALIGN(4K) (NOLOAD) : AT (ADDR(__stackguard_lower) - KERNEL_VADDR_BASE) {
        __stackguard_lower = .;
        . += 4K;
    } :__stackguard_lower
}
```

`.text` / `.rodata` / `.data` / `.bss` についてはそのままです。
各オブジェクトファイルに存在するセクションを集めて最終的な実行ファイルのセクションを構成しています。
`AT` は物理アドレスを指定しています。
`ADDR(.text)`は `.text` セクションの仮想アドレスになるため、そこから `KERNEL_VADDR_BASE` を引いた値をセクションの物理アドレスとします。
つまり、ベースの仮想アドレスからのオフセットをそのまま物理アドレスにしているということです。

新たに `__stack` セクションを追加しています。
スタックのサイズはとりあえず5ページです。足りなくなったら足せばいいだけです、今回は十分ですが。
他のセクションとの違いとして、`NOLOAD` を指定しています。
`NOLOAD` を指定すると、その領域はメモリにロードされないという意味になります。
スタック領域は初期値が不要なため、ELF ファイルには含める必要がありません。
セクションのサイズには `STACK_SIZE` を指定しますが、これによって **ELF 自体のサイズが変わるということはありません**。

スタックの両側に配置してある `__stackguard_upper` / `__stackguard_lower` は**スタックガードページ**です。
このページを read-only にすることで、スタックオーバーフローやスタックアンダーフローが発生した場合にページフォルトを発生させます[^4]。
気づかないうちにスタックが溢れて隣接する領域を破壊してしまうことを防ぐ目的です。

<div class="warning">
Stack Overflow からの Triple Fault

スタックがオーバーフローしてガードページへの書き込みが発生すると、ページフォルトが発生します。
フォルトハンドラがガードページをスタックとして利用しようとすることで再度フォルトが発生してしまいます。
これは double fault を引き起こし、その中で同様にしてフォルトが起こります。
最終的には **triple fault を引き起こし、CPU がリセットされてこの世の終わりが訪れます...**。

これを防ぐためには、ページフォルトハンドラでスタックを独自のものに切り替える必要があります。
割り込みハンドラ用のスタックは [TSS](https://wiki.osdev.org/Task_State_Segment) という領域に保存できます。
TSS と GDT と IDT を適切に設定することでページフォルトのときのみ独自のスタックに切り替えることができます[^5]。

本シリーズでは TSS は使わず、割り込みが発生した瞬間のスタックをそのまま使います。
スタックオーバーフローはすぐに triple fault になってしまうので、嫌な人は TSS を使って独自スタックを実装してみてください。
</div>

各セクションの最後に書いてある `:segment` は、そのセクションを `segment` セグメントに配置します。
セグメントの定義は以下です:

```ymir/linker.ld
PHDRS {
    text PT_LOAD;
    rodata PT_LOAD;
    data PT_LOAD;
    bss PT_LOAD;

    __stackguard_upper PT_LOAD FLAGS(4);
    __stack PT_LOAD FLAGS(6);
    __stackguard_lower PT_LOAD FLAGS(4);
}
```

各セグメントに指定している `PT_LOAD` は、そのセグメントをメモリにロードすることを示します。
セクションに指定した `NOLOAD` はセクションに対する指定であり、`PT_LOAD` はセグメントに対する指定です。
`FLAGS` にはセグメントの属性を指定します。
RWX の左から 4, 2, 1 の値を持ちます。
`text` / `rodata` / `data` / `bss` セグメントには `FLAGS` を指定せず、セクションの属性をそのまま使います。
`__stack` は RW (実行不可) にしたいため、`FLAGS(6)` です。
ガードページは read-only にするため、`FLAGS(4)` です。

### セクションとセグメントの確認

スタックを含めた Ymir のレイアウトが設定できたため、意図したとおりのレイアウトになっているかを確認しましょう。
`zig build install` で Ymir をビルドした後、`readelf` でセクションとセグメントの情報を表示させます:

```bash
> readelf --segment --sections ./zig-out/bin/ymir.elf

Section Headers:
  [Nr] Name              Type             Address           Offset
       Size              EntSize          Flags  Link  Info  Align
  [ 0]                   NULL             0000000000000000  00000000
       0000000000000000  0000000000000000           0     0     0
  [ 1] .text             PROGBITS         ffffffff80100000  00001000
       0000000000000003  0000000000000000 AXl       0     0     16
  [ 2] .rodata           PROGBITS         ffffffff80101000  00001003
       0000000000000000  0000000000000000   A       0     0     1
  [ 3] .data             PROGBITS         ffffffff80101000  00001003
       0000000000000000  0000000000000000   A       0     0     1
  [ 4] .bss              NOBITS           ffffffff80101000  00001003
       0000000000000000  0000000000000000  WA       0     0     1
  [ 5] __stackguard[...] NOBITS           ffffffff80101000  00002000
       0000000000001000  0000000000000000  WA       0     0     1
  [ 6] __stack           NOBITS           ffffffff80102000  00002000
       0000000000005000  0000000000000000  WA       0     0     1
  [ 7] __stackguard[...] NOBITS           ffffffff80107000  00002000
       0000000000001000  0000000000000000  WA       0     0     1
...
  [16] .symtab           SYMTAB           0000000000000000  00003250
       00000000000000a8  0000000000000018          18     2     8
  [17] .shstrtab         STRTAB           0000000000000000  000032f8
       00000000000000c9  0000000000000000           0     0     1
  [18] .strtab           STRTAB           0000000000000000  000033c1
       0000000000000058  0000000000000000           0     0     1

Program Headers:
  Type           Offset             VirtAddr           PhysAddr
                 FileSiz            MemSiz              Flags  Align
  LOAD           0x0000000000001000 0xffffffff80100000 0x0000000000100000
                 0x0000000000000003 0x0000000000000003  R E    0x1000
  LOAD           0x0000000000002000 0xffffffff80101000 0x0000000000101000
                 0x0000000000000000 0x0000000000001000  R      0x1000
  LOAD           0x0000000000002000 0xffffffff80102000 0x0000000000102000
                 0x0000000000000000 0x0000000000005000  RW     0x1000
  LOAD           0x0000000000002000 0xffffffff80107000 0x0000000000107000
                 0x0000000000000000 0x0000000000001000  R      0x1000

 Section to Segment mapping:
  Segment Sections...
   00     .text
   01     .bss __stackguard_upper
   02     __stack
   03     __stackguard_lower
```

以下のようなことが分かります:

- `__stack` やガードページのセクションは:
  - `Size` が指定したページサイズになっている。
  - `Addr` が指定した仮想アドレスになっている。
  - `Offset` (ELFファイル内におけるセクションの開始アドレス) が同じ `0x2000` になっている。
これは、**セクション自体がサイズを持たず ELF バイナリ内に含まれない**ことを示している。
- `__stack` やガードページのセグメントは:
  - `FileSize` が `0` になっている。これもELF内にデータが含まれないことを示す。
  - `MemSize` が指定したページサイズになっている。
  - `VirtAddr` と `PhysAddr` が指定した仮想アドレス・物理アドレスになっている。
- スタックは read-write になっている。
- ガードページは read-only になっている。
- `.bss` セクションと `__stackguard_upper` セクションが同じセグメントになっている。
これは現在 Ymir が `.bss` に入れる変数を持っていないから。

<div class="warning">
セクションとセグメントの属性

余談ですが、セグメントやセクションの属性等は一般的な意味[^6]から逸脱していても全く問題ありません。
というのも、これらをパースするローダである Surtr は本シリーズで自作するものであり、値をどう解釈するかはこちらの一存で決めることができるからです。
</div>

## Stack Trampoline

スタックを用意したので、UEFI が用意したスタックからカーネルのスタックへと切り替えます。

Ymir のエントリポイントである `kernelEntry()` を以下のように変更します:

```ymir/main.zig
extern const __stackguard_lower: [*]const u8;

export fn kernelEntry() callconv(.Naked) noreturn {
    asm volatile (
        \\movq %[new_stack], %%rsp
        \\call kernelTrampoline
        :
        : [new_stack] "r" (@intFromPtr(&__stackguard_lower) - 0x10),
    );
}
```

`__stackguard_lower` は先程リンカスクリプトで定義した `__stackguard_lower` セクションの先頭アドレスに位置しています。
この変数はアドレスしか使わないので実際には型は不要です。
インラインアセンブラでは `__stackguard_lower` セクションから 0x10 だけずらしたアドレスをスタックポインタにセットしています。
これでスタックが用意したカーネルスタックに切り替わります。

`kernelTrampoline()` は Zig の通常の calling convention を持つ関数にジャンプするためのトランポリン関数です:

```ymir/main.zig
export fn kernelTrampoline(boot_info: surtr.BootInfo) callconv(.Win64) noreturn {
    kernelMain(boot_info) catch |err| {
        log.err("Kernel aborted with error: {}", .{err});
        @panic("Exiting...");
    };

    unreachable;
}

fn kernelMain(bs: boot_info: surtr.BootInfo) !void {
    while (true) asm volatile("hlt");
}
```

`kernelEntry()` は関数のプロローグを持ってはいけません。
スタックを切り替える前にスタックに何かを push してしまう可能性があるためです。
よって、`callconv(.Naked)` を指定しています。

Ymir のメイン関数は通常の Zig の calling convention を持ち、返り値としてエラーも返せるようにしたいです。
そうしないと `try` などの便利キーワードも使えなくなってしまうからです。
しかし、**`callconv(.Naked)` から Zig のコードで関数呼び出しはできません**。
Inline assembly を使うしかないです。
そこで、 `kernelTrampoline()` を間に入れます。
この関数は引数を適切に受け渡しつつ、calling convention を切り替えます。

`kernelEntry()` の先頭では、Surtr から渡された引数は UEFI calling convention に則って渡されており、
引数の `BootInfo` は RCX に入っています。
よって、`kernelTrampoline()` は `callconv(.Win64)` を指定します。
`callconv(.Win64)` の関数からは他の calling convention を持つ関数を通常通り呼び出すことができるため、
`kernelMain()` を Zig-way で呼び出せるという算段です。

<div class="warning">
export keyword

`export` keyword を関数につけることで、その関数は定義したままの名前で参照できるようになります。
`kernelMain()` や `kernelTrampoline()` はアセンブラから `call` するため、`export` をつけています。
もしも `export` をつけない場合、関数の名前は `main.kernelTrampoline` のようなファイル名/モジュール名を含んだ名前になってしまいます。
</div>

## `BootInfo` の検証

Surtr の役割は終わり、Ymir が実権を握りました。
このチャプターの最後として、Surtr が渡してくれた引数 `BootInfo` の sanity check をしておきましょう。

まず、Ymir が Surtr の定義した情報を参照できるように Surtr モジュールを作成し Ymir に追加します。
`build.zig` に以下を追加します:

```build.zig
// Modules
const surtr_module = b.createModule(.{
    .root_source_file = b.path("surtr/defs.zig"),
});
...
ymir.root_module.addImport("surtr", surtr_module);
```

これで、 `@import("surtr")` によって `surtr/defx.zig` を参照できるようになりました。
`kernelMain()` で `BootInfo()` の検証をしましょう:

```ymir/main.zig
// Validate the boot info.
validateBootInfo(bs_boot_info) catch |err| {
    // 本当はここでログ出力をしたいけど、それはまた次回
    return error.InvalidBootInfo;
};

fn validateBootInfo(boot_info: surtr.BootInfo) !void {
    if (boot_info.magic != surtr.magic) {
        return error.InvalidMagic;
    }
}
```

`BootInfo` の先頭には、Surtr がマジックナンバーを格納してくれているはずです。
この値が正しく設定されているかを確認することで、Surtr が正しく引数を渡してくれたかを検証します。

仮に `magic` が正しくない場合、`error.InvalidMagic` を返します。
本来ならばここでエラー出力をしたいところですが、まだ Ymir ではログシステムを用意していません。
次のチャプターでは、ログ出力を実装していくことにしましょう。

[^1]: [Detailed Calling Conventions - UEFI Specification 2.9 Errata A](https://uefi.org/specs/UEFI/2.9_A/02_Overview.html#detailed-calling-conventions)
[^2]: 本当はスタック用に動的にメモリを確保し、その領域に仮想アドレスをマップしてあげるべきですが、
めんどうなので本シリーズではこの領域をずっとスタックとして使い続けることにします。
[^3]: [Optional Section Attributes - Using ld The GNU linker](https://ftp.gnu.org/old-gnu/Manuals/ld-2.9.1/html_node/ld_21.html)
[^4]: 通常、ガードページはそもそもマッピングしない場合が多いです。
しかし、やっぱりめんどうなので今回は read-only にするという方法でガードすることにします。
[^5]: [Double Faults - Writing an OS in Rust](https://os.phil-opp.com/double-fault-exceptions/)
[^6]: [Linker and Libraries Guide](https://docs.oracle.com/cd/E19683-01/816-1386/chapter6-83432/index.html)
