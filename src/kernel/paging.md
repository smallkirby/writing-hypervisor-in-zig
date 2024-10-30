# ページング

本チャプターは UEFI が用意してくれたものを Ymir のものに置き換えていこうシリーズの最終弾です。
最後を飾るのはページング、つまりメモリマップです。
UEFI が用意したページテーブルは仮想アドレスをそのまま物理アドレスにするダイレクトマップ(ストレートマップ)でした。
Ymir が新しく用意するマッピングもダイレクトマップではありますが、仮想アドレスと物理アドレスが異なるようにオフセットを加算します。
本チャプターを終えると、UEFI が提供したものを全て破棄できる状態になります。

## Table of Contents

<!-- toc -->

## 仮想アドレスレイアウト

[カーネルのロード](../bootloader/load_kernel.md) でも扱いましたが、Ymir では以下の仮想アドレスレイアウトを採用します:

| Description | Virtual Address | Physical Address |
| --- | --- | --- |
| Direct Map Region | `0xFFFF888000000000` - `0xFFFF88FFFFFFFFFF` (512GiB) | `0x0` - `0xFFFFFFFFFF` |
| Kernel Base | `0xFFFFFFFF80000000` - | `0x0` - |
| Kernel Text | `0xFFFFFFFF80100000` - | `0x100000` - |

**Direct Map Region** は全物理アドレスをダイレクトマップします。
ダイレクトマップとはいっても、仮想アドレスと物理アドレスが等しくなるわけではありません。
仮想アドレスと物理アドレスの間にはオフセットが `0xFFFF888000000000` があります。
この領域にはヒープも含まれます。

**Kernel Base** と **Kernel Text** はカーネルイメージをロードする領域です。
`ymir/linker.ld` によってカーネルイメージはこのアドレスにロードされるよう要求するようになっています。
この仮想アドレスは既に [カーネルのロード](../bootloader/load_kernel.md#仮想アドレスのマップ) の部分でマップ済みです。

各仮想アドレスがマップされる物理アドレスを見て分かるように、Direct Map Region と Kernel Base は重複しています。
同じ物理アドレスが複数の仮想アドレスからマップされること自体はごく普通のことです。
基本的にソフト側で扱うアドレスは仮想アドレスであるため、アドレスからどの領域かがわかりやすくなるように異なる仮想アドレスをマップしています。
`0xFFFFFFFF8010DEAD` というアドレスを見たらすぐに「Ymir のコード領域だな」とわかるので便利ですね。

もちろん、これ以外のレイアウトを採用することも容易にできます。
最も簡単なのは、全ての仮想アドレスを物理アドレスにオフセット無しで 1:1 にマップすることです。
本シリーズで実装する Ymir に関しては、そうした場合でもデメリットはありません。
お好きなレイアウトを採用してください。

## 再構築の流れ

ここからは、UEFI が提供してくれたページテーブルを「*古いページテーブル*」、Ymir が提供するページテーブルを「*新しいページテーブル*」と呼びます。
古いページテーブルを新しいものに置き換えるには、以下の手順を踏みます:

1. 新しい Lv4 ページテーブルを用のページを確保する
2. 1GiB ページを使って Direct Map Region をマップする
3. 古いページテーブルから Kernel Base Region のマップをクローンする
4. 新しいページテーブルをロードする；ｗ

2 で Direct Map Region である `0xFFFF888000000000` からの 512GiB をマップします。
これは古いページテーブルの内容を参照すること無く行うことができます。
しかしながら、カーネルがどこにマップされたのかは古いページテーブルを見ないとわかりません[^kernel-map]。
よって、この領域は古いページテーブルを参照して内容をクローンする必要があります。

## 新しい Lv4 ページテーブルの確保

以前 Surtr で実装した `page.zig` は、ほとんどそのまま `ymir/arch/x86/page.zig` にコピーできます。
具体的には、各種定数や `EntryBase`構造体, `getTable()`, `getEntry()` 等の関数をコピーします。

ページテーブルは 8byte のエントリが 512 個並んだものです。
すなわち、サイズは 4KiB (1ページ) 分です。
ページテーブル1つにつき1ページを確保するため、1ページを確保するためのヘルパー関数を用意します:

```ymir/arch/x86/page.zig
fn allocatePage(allocator: Allocator) PageError![*]align(page_size_4k) u8 {
    return (allocator.alignedAlloc(
        u8,
        page_size_4k,
        page_size_4k,
    ) catch return PageError.OutOfMemory).ptr;
}
```

`Allocator` は [前チャプター](./page_allocator.md) で実装した `PageAllocator` をバックに持つアロケータです。
しかしながら、`PageAllocator` であることは意識せずに Zig 標準の `Allocator` として使うことができます。
確保するページは性質上 4KiB アラインが要求されるため、`alignedAlloc()` でアラインされた領域を確保します。

マッピングを再構築する関数は `reconstruct()` とします:

```ymir/arch/x86/page.zig
pub fn reconstruct(allocator: Allocator) PageError!void {
    const lv4tbl_ptr: [*]Lv4Entry = @ptrCast(try allocatePage(allocator));
    const lv4tbl = lv4tbl_ptr[0..num_table_entries]; // 256
    @memset(lv4tbl, std.mem.zeroes(Lv4Entry));
    ...
}
```

まず最初に新しい Lv4 ページテーブルを確保します。
`allocatePage()` が返す領域は [many-item pointer](https://ziglang.org/documentation/master/#Pointers) であるため、
テーブルあたりのエントリ数 256 でスライスを作っています。
作成したページテーブルはとりあえず全部ゼロ埋めしておきます。
ゼロ埋めすることでエントリの `present` フィールドが 0 になるため、何もマップしない状態になります。
念の為以下にページテーブルエントリの構造を再掲しておきます:

![Formats of CR3 and Paging-Structure Entries with 4-Level Paging](../assets/sdm/paging-structure-entries.png)
*Formats of CR3 and Paging-Structure Entries with 4-Level Paging. SDM Vol.3A 4.5.5*

## Direct Map Region

作成したまっさらなページテーブルに Direct Map Region をマップします:

TODO

```ymir/arch/x86/page.zig
const lv4idx_start = (direct_map_base >> lv4_shift) & index_mask;
const lv4idx_end = lv4idx_start + (direct_map_size >> lv4_shift);

// Create the direct mapping using 1GiB pages.
for (lv4tbl[lv4idx_start..lv4idx_end], 0..) |*lv4ent, i| {
    const lv3tbl: [*]Lv3Entry = @ptrCast(try allocatePage(allocator));
    for (0..num_table_entries) |lv3idx| {
        lv3tbl[lv3idx] = Lv3Entry.newMapPage(
            (i << lv4_shift) + (lv3idx << lv3_shift),
            true,
        );
    }
    lv4ent.* = Lv4Entry.newMapTable(lv3tbl, true);
}
```

![Direct Map Region](../assets/drawio/remap.drawio.png)
*Direct Map Region*

TODO

> [!NOTE] ページサイズ
> 今回は Direct Map Region を 1GiB ページでマップしました。
> 4KiB ページを使うと 1GiB をマップするのに \\( 2^{18} \\) 個のエントリが必要になります。
> 1エントリあたり 8byte なので、合計で \\( 2^{18} \times 8 = 2^{21} = 2\text{MiB} \\) になります。
> 今回は 512GiB をマップするため、4KiB ページを使うとテーブルエントリだけで 1GiB になってしまいます。
> できるだけ大きいページを使うことでページテーブルのエントリ数を減らすことができます。
> 今回 1GiB を使ったのもそのためです。

## Surtr のマッピング改良

TODO

[^kernel-map]: 厳密には、「どこにロードされたのか」は Ymir 側で指定しているので分かります。
分からないのは、ロードされたイメージのサイズや、(セグメント等のページ属性を分けてロードした場合には)各セグメントのサイズやアドレス等です。
