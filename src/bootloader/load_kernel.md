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

[^1]: [Complete virtual memory map with 4-level page tables - kernel.org](https://www.kernel.org/doc/Documentation/x86/x86_64/mm.txt)
[^2]: [BitVisorの仮想メモリーマップ](https://qiita.com/hdk_2/items/6c7aaa72f5dcfcfda342)
