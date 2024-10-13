# 環境構築

本チャプターでは、hypervisor の開発に必要な環境構築のステップを説明します。

## Table of Contents

<!-- toc -->

## 想定する環境

以下の環境における開発を想定しています:

- [Intel VT-x](https://en.wikipedia.org/wiki/X86_virtualization) がサポートされている x64 アーキテクチャ
- Nested Virtualization がサポートされているVMM
  - Linux であれば QEMU/KVM が Nested Virtualization をサポートしていて、CPUをパススルーできる
- Zig 0.13.0

筆者は以下の環境での動作を確認しています:

- 12th Gen Intel(R) Core(TM) i9-12900
- Ubuntu 24.04 LTS (Linux 6.8.0-45-generic)
- QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.2)

CPU に関しては、最近の Intel Core シリーズであればほぼ確実に VT-x がサポートされていると思われます。
実装は仮想環境上で行うため、必然的に Nested Virtualization できる環境が必要になります。
[VirtualBox](https://www.virtualbox.org/) でも [VMWare](https://www.vmware.com/) でも問題ない可能性はありますが、本シリーズでは QEMU/KVM の使用を想定します。

### VT-x をサポートしているかの確認

以下のコマンドで CPU が VT-x をサポートしているか確認できます。

```bash
cat /proc/cpuinfo | grep vmx
```

## Zig

本シリーズでは、[Zig](https://ziglang.org/download/) 0.13.0 を使用します。
Zig には公式のバージョンマネージャが存在しないため、以下のいずれかの方法でインストールしてください。

### zvm を使う

サードパーティ製の Zig バージョンマネージャのひとつに [tristanisham/zvm](https://github.com/tristanisham/zvm) があります。
GitHub の README から環境に合った方法で zvm をインストールした後、以下のコマンドで 0.13.0 をインストールします。

```bash
zvm install 0.13.0
zvm use 0.13.0
```

### 公式ページからバイナリをダウンロード

Zig の[リリースページ](https://ziglang.org/download/)から 0.13.0 のバイナリをダウンロードし、パスが通っているディレクトリに配置してください。

## OVMF

[OVMF](https://github.com/tianocore/tianocore.github.io/wiki/OVMF) は VM 上で UEFI をサポートするプロジェクトです。
QEMU ではデフォルトで [SeaBIOS](https://www.seabios.org/SeaBIOS) と呼ばれるレガシーBIOSが使われますが、本シリーズでは OVMF を使って起動することで最初から [long mode](https://en.wikipedia.org/wiki/Long_mode) での実行が可能になります。
Ubuntu を使っている場合には以下のコマンドでインストールできます。

```bash
sudo apt install ovmf
```
