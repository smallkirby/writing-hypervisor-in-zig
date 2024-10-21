# カーネルのロード

前回までで 4KiB ページのマップができるようになりました。
本チャプターでは Ymir カーネルのELFファイルをパースし、要求する仮想アドレスにカーネルをロードしていきます。

## Table of Contents

<!-- toc -->

## Ymir のリンカスクリプト

まず最初に Ymir の仮想アドレスレイアウトを決めます。
アドレスレイアウトをどのようにするかには特に決まりがありません。

例えば、Linux ではユーザランドとカーネルごとに利用する仮想アドレス空間を分けており、
カーネルの中でもある部分は `.text` がマップ、ある部分は物理アドレスに direct map されていたりします[^1]。

また、BitVisor では以下のような仮想アドレスのレイアウトになっているようです[^2]:

| 仮想アドレス | 説明 |
| --- | --- |
| 0x0000000000 - 0x003FFFFFFF | プロセス |
| 0x0040000000 - 0x007FFFFFFF | カーネル |
| 0x00F0000000 - 0x00FEFFFFFF | 物理アドレスの動的割当て |
| 0x8000000000 - 0x8FFFFFFFFF | 物理アドレスの静的割当て |

Ymir では特に理由はなく Linux のレイアウトに近いものを採用します。
Ymir の仮想アドレスレイアウトは以下のようになります:

| 仮想アドレス | 説明 |
| --- | --- |
| 0xFFFF888000000000 - 0xFFFF88FFFFFFFFFF (512GiB) | Direct Map. 物理アドレスの 0 にマップされる。ヒープもここ。 |
| 0xFFFFFFFF80000000 - | Kernel Base. |
| 0xFFFFFFFF80100000 - | Kernel Text. |

これらのレイアウトを実現するため、リンカスクリプトを書きます:

```ld
/* -- ymir/linker.ld -- */

KERNEL_VADDR_BASE = 0xFFFFFFFF80000000;
KERNEL_VADDR_TEXT = 0xFFFFFFFF80100000;

SECTIONS {
    . = KERNEL_VADDR_TEXT;

    .text ALIGN(4K) : AT (ADDR(.text) - KERNEL_VADDR_BASE) {
        *(.text)
        *(.ltext)
    }

    .rodata ALIGN(4K) : AT (ADDR(.rodata) - KERNEL_VADDR_BASE) {
        *(.rodata)
    }

    .data ALIGN(4K) : AT (ADDR(.data) - KERNEL_VADDR_BASE) {
        *(.data)
    }

    .bss ALIGN(4K) : AT (ADDR(.bss) - KERNEL_VADDR_BASE) {
        *(COMMON)
        *(.bss)
    }
}
```

このリンカスクリプトによって全てのセクションは仮想アドレスの `0xFFFFFFFF80100000` 以降に配置されるようになります。
また、それらのセクションは仮想アドレスから `0xFFFFFFFF80000000` を引いた物理アドレスにマップされます。

リンカスクリプトをビルドに含めるには、`build.zig` で以下のように指定します:

```zig
// -- build.zig --

ymir.linker_script = b.path("ymir/linker.ld");
```

ビルドをして生成された ELF ファイルのセグメントを確認してみましょう:

```bash
> readelf --segment ./zig-out/bin/ymir.elf

Elf file type is EXEC (Executable file)
Entry point 0xffffffff80100000
There are 2 program headers, starting at offset 64

Program Headers:
  Type           Offset             VirtAddr           PhysAddr
                 FileSiz            MemSiz              Flags  Align
  LOAD           0x0000000000001000 0xffffffff80100000 0x0000000000100000
                 0x0000000000000003 0x0000000000000003  R E    0x1000
  GNU_STACK      0x0000000000000000 0x0000000000000000 0x0000000000000000
                 0x0000000000000000 0x0000000001000000  RW     0x0

 Section to Segment mapping:
  Segment Sections...
   00     .text
   01
```

まだ Ymir カーネル自体がほとんど何もしない関数であるため、`.text`セクションですら 3byte しかありません。
しかし、エントリポイントが `0xFFFFFFFF80100000` であることや、そのセグメントが物理アドレスの `0x100000` にマップされていることがわかります。
意図したとおりに配置されているようですね。

<div class="warning">
本当に良いレイアウトは？

Ymir では Linux に近いレイアウトを採用しました。
特に理由はないですが、Linux をある程度触ったことがある人にとってはなんとなく直感的であるような気がしたからです。
しかし、Linux に近いレイアウトを採用することは寧ろ良くない選択かもしれません。

というのも、Linux に近いレイアウトを採用した場合、あるアドレスが Ymir のアドレスなのかゲスト Linux のアドレスなのかが分かりにくくなります。
`0xFFFFFFFF80100000` というアドレスに breakpoint を設定した場合、Ymir が実行した場合もゲスト Linux が実行した場合もどちらもヒットしてしまいます。
Breakpoint にヒットしたあとで、それが Ymir かゲスト Linux かを判断するのは少し面倒です。
そうであるならば、最初から Linux と絶対に被らないような領域を使う方が、デバッグする上では好ましいのかもしれません。
</div>

## カーネル用のメモリの確保

Ymir カーネルのレイアウトが決まったので、今度はカーネルをメモリにロードする準備をします。
具体的には、カーネルをロードするメモリとして必要なサイズを計算し、その分だけメモリを確保します。

カーネルのサイズは ELF ファイルをパースして得られるカーネルのメモリマップから計算します。
まずは ELF のセグメントヘッダのイテレータを作成します:

```zig
// -- surtr/boot.zig --

const Addr = elf.Elf64_Addr;
var kernel_start_virt: Addr = std.math.maxInt(Addr);
var kernel_start_phys: Addr align(page_size) = std.math.maxInt(Addr);
var kernel_end_phys: Addr = 0;

var iter = elf_header.program_header_iterator(kernel);
```

カーネルを配置する物理アドレスの最小と最大のを記録する変数、及び仮想アドレスの最小を記録する変数を用意します。
セグメントヘッダのイテレータは、`std.elf.Header.program_header_iterator()` で作成できます。
このイテレータを使ってセグメントヘッダを辿り、最小・最大アドレスに配置されるセグメントのアドレスを計算していきます:

```zig
// -- surtr/boot.zig --

while (true) {
    const phdr = iter.next() catch |err| {
        log.err("Failed to get program header: {?}\n", .{err});
        return .LoadError;
    } orelse break;
    if (phdr.p_type != elf.PT_LOAD) continue;
    if (phdr.p_paddr < kernel_start_phys) kernel_start_phys = phdr.p_paddr;
    if (phdr.p_vaddr < kernel_start_virt) kernel_start_virt = phdr.p_vaddr;
    if (phdr.p_paddr + phdr.p_memsz > kernel_end_phys) kernel_end_phys = phdr.p_paddr + phdr.p_memsz;
}
```

セグメントのタイプが `PT_LOAD`[^3] であるセグメントにおいて、現在分かっている最小・最大のセグメントのアドレスを更新する場合には、そのアドレスを記録します。

続いて、必要なメモリサイズを計算します:

```zig
// -- surtr/boot.zig --

const pages_4kib = (kernel_end_phys - kernel_start_phys + (page_size - 1)) / page_size;
log.info("Kernel image: 0x{X:0>16} - 0x{X:0>16} (0x{X} pages)", .{ kernel_start_phys, kernel_end_phys, pages_4kib });
```

セグメントの最小アドレスと最大アドレスの差分から、必要な 4KiB ページの数を計算します。
`(A - B + (C - 1)) / C` は `(A + B) / C` の余りが 0 でない場合に切り上げて1を足す式です。

実行すると以下の出力になります:

```txt
[INFO ] (surtr): Initialized bootloader log.
[INFO ] (surtr): Got boot services.
[INFO ] (surtr): Located simple file system protocol.
[INFO ] (surtr): Opened filesystem volume.
[INFO ] (surtr): Opened kernel file.
[INFO ] (surtr): Parsed kernel ELF header.
[INFO ] (surtr): Kernel image: 0x0000000000100000 - 0x0000000000100003 (0x1 pages)
```

現在 Ymir のセグメントサイズは `kernelEntry()` の 3byte のみであるため、歪な出力になっていますね。
しかし、`readelf` でセグメントヘッダを呼んだ時の結果と一致しており、
必要なページサイズが 1 ページであることも正しく計算できているようです。

最後に、計算したページ分だけメモリを確保してあげます。

```zig
// -- surtr/boot.zig --

status = boot_service.allocatePages(.AllocateAddress, .LoaderData, pages_4kib, @ptrCast(&kernel_start_phys));
if (status != .Success) {
    log.err("Failed to allocate memory for kernel image: {?}", .{status});
    return status;
}
log.info("Allocated memory for kernel image @ 0x{X:0>16} ~ 0x{X:0>16}", .{ kernel_start_phys, kernel_start_phys + pages_4kib * page_size });
```

全チャプターと同様に、 Boot Services の [AllocatePages()](https://uefi.org/specs/UEFI/2.9_A/07_Services_Boot_Services.html#efi-boot-services-allocatepages) を使ってページを確保します。
ただし、ここでは**第1引数の `alloca_type` として `.AllocateAddress` を指定することで、第4引数で指定したアドレス丁度にメモリを確保**させます。
このアドレスは、先程計算したセグメントの開始アドレスです。
もしも指定された物理アドレスからメモリを確保できなかった場合にはエラーが返ります。

## 仮想アドレスのマップ

カーネルが要求する物理アドレスにメモリを確保できたため、次は要求する仮想アドレスを確保した物理アドレスにマップします。
[簡易ページテーブルのチャプター](simple_pg.md) で 4KiB ページをマップする関数を実装したため、それを使ってページをマップします:

```zig
// -- surtr/boot.zig --

for (0..pages_4kib) |i| {
    arch.page.map4kTo(
        kernel_start_virt + page_size * i,
        kernel_start_phys + page_size * i,
        .read_write,
        boot_service,
    ) catch |err| {
        log.err("Failed to map memory for kernel image: {?}", .{err});
        return .LoadError;
    };
}
log.info("Mapped memory for kernel image.", .{});
```

確保した 4KiB ページの枚数分(`pages_4kib`)だけマップを繰り返します。
本当であれば、セグメントヘッダが要求する属性(読み込み専用等)でマップするべきですが、ここでは簡単のために全て `.read_write` でマップします。

実行してメモリマップを確認すると以下のようになります:

```txt
Virtual address start-end              Physical address start-end             Total size   Page size   Count  Flags
0x0000000000000000-0x0000000000200000  0x0000000000000000-0x0000000000200000  0x200000     0x200000    1      [RWX KERN ACCESSED DIRTY]
0x0000000000200000-0x0000000000800000  0x0000000000200000-0x0000000000800000  0x600000     0x200000    3      [RWX KERN ACCESSED]
...
0xffffffff80100000-0xffffffff80101000  0x0000000000100000-0x0000000000101000  0x1000       0x1000      1      [RWX KERN GLOBAL]
```

仮想アドレスの `0xFFFFFFFF80100000` から1ページ分だけ物理アドレスの `0x0000000000100000` にマップされていることがわかります。
うまくマップできているようですね。

## カーネルの読み込みとロード

最後に、用意したメモリにカーネルをロードしていきます。

### セグメントの読み込み

まずは、先ほど必要なメモリサイズを計算したときと同様なセグメントヘッダのイテレータを作成するところから始めます:

```zig
// -- surtr/boot.zig --

log.info("Loading kernel image...", .{});
iter = elf_header.program_header_iterator(kernel);
while (true) {
    const phdr = iter.next() catch |err| {
        log.err("Failed to get program header: {?}\n", .{err});
        return .LoadError;
    } orelse break;
    if (phdr.p_type != elf.PT_LOAD) continue;

    ...
}
```

ロードする必要があるのは、やはり `PT_LOAD` セグメントだけです。それ以外の場合にはスキップします。
続いて、セグメントをファイルからメモリに読み出します:

```zig
// -- surtr/boot.zig --

status = kernel.setPosition(phdr.p_offset);
if (status != .Success) {
    log.err("Failed to set position for kernel image.", .{});
    return status;
}
const segment: [*]u8 = @ptrFromInt(phdr.p_vaddr);
var mem_size = phdr.p_memsz;
status = kernel.read(&mem_size, segment);
if (status != .Success) {
    log.err("Failed to read kernel image.", .{});
    return status;
}
log.info(
    "  Seg @ 0x{X:0>16} - 0x{X:0>16}",
    .{ phdr.p_vaddr, phdr.p_vaddr + phdr.p_memsz },
);
```

ここで、`kernel` は [カーネルのパース](parse_kernel.md) で作った `*uefi.protocol.File` です。
`setPosition()` でセグメントの開始オフセットまでシークしたあと、
セグメントヘッダが要求する仮想アドレスに対して、セグメントをファイルから読み出します。
とてもシンプルです。

<div class="warning">
仮想アドレスと物理アドレス

ページング周りのコードを書く際は、仮想アドレスと物理アドレスを取り違えるミスをしやすいです。
しかし、**Surtr においては実はそこまで両者を意識する必要はありません**。
というのも、UEFI が提供するマッピングは仮想アドレスをストレートに物理アドレスへとマップするため、
仮想アドレスと物理アドレスが等しくなるからです。

なお、カーネルをロードしようとしているメモリは先ほど新たに仮想アドレスをマップしました。
しかし依然としてストレートマップも有効のままです。
そのため、この物理アドレスに対しては2通りの仮想アドレスを介してアクセスできます。
試しに上のコードの `phdr.p_vaddr`(新しく作成したマップ)を `phdr.p_paddr`(ストレートマップ)に変更してみてください。
問題なく動くはずです。
</div>

### BSS セグメントの初期化

[`.bss` セクション](https://en.wikipedia.org/wiki/.bss) は、ゼロ初期化されるセクションです。
ゼロ初期化されることが分かっているため、ELF ファイル中には `.bss` セクションのデータは含まれていません。
セグメントをロードする際に、`.bss` セクションのサイズだけメモリを確保し、ゼロで初期化します。
既にメモリは確保してあるため、ここではゼロ初期化を行いましょう:

```zig
// -- surtr/boot.zig --

const zero_count = phdr.p_memsz - phdr.p_filesz;
if (zero_count > 0) {
    boot_service.setMem(@ptrFromInt(phdr.p_vaddr + phdr.p_filesz), zero_count, 0);
}
```

ゼロ埋めには Zig の `@memset()` 関数も利用できますが、
せっかくなので UEFI が提供してくれる [SetMem()](https://uefi.org/specs/UEFI/2.10/07_Services_Boot_Services.html#miscellaneous-boot-services) を使ってみました。
これで `.bss` セクションの初期化は完了です[^4]。
まぁ、今の Ymir には `.bss` セクションは存在しないので実際には何も起こらないんですが...。

## アウトロ

本チャプターでは、 Ymir カーネルをロードするのに必要なメモリサイズを計算し、その分だけ物理メモリを確保しました。
その後、カーネルが要求する通りに仮想アドレスをマップし、そこにカーネルをロードしました。

これでいよいよ Ymir を実行する準備ができました。
すぐに Ymir にジャンプしてもいいですが、次回1チャプターは少しお片付けをして、それからカーネルに飛び込むことにしましょう。

[^1]: [Complete virtual memory map with 4-level page tables - kernel.org](https://www.kernel.org/doc/Documentation/x86/x86_64/mm.txt)
[^2]: [BitVisorの仮想メモリーマップ](https://qiita.com/hdk_2/items/6c7aaa72f5dcfcfda342)
[^3]: [Executable and Linking Format (ELF) Specification Version 1.2](https://refspecs.linuxfoundation.org/elf/elf.pdf)
[^4]: 厳密には、この方法は `.bss` セクション以外のセクション/セグメントもゼロクリアします。
例えば `.text` セグメントのサイズが `0x800` であった場合、セグメントのサイズは 4KiB アラインされるため `.text` セクションの後に `0x800` byte の空白ができることになります。
今回の方法では、この空白部分もついでにゼロクリアしています(悪いことではありません)。
