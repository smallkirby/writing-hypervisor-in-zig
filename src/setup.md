# 環境構築

本チャプターでは、hypervisor の開発に必要な環境の構築について説明します。

## Table of Contents

<!-- toc -->

## 想定する環境

以下の環境における開発を想定しています:

- [Intel VT-x](https://en.wikipedia.org/wiki/X86_virtualization) がサポートされている x64 (IA-64) アーキテクチャ
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

### VT-x をサポートしているかを確認

以下のコマンドで CPU が VT-x をサポートしているか確認できます:

```bash
cat /proc/cpuinfo | grep vmx
```

## Zig

本シリーズでは、[Zig](https://ziglang.org/download/) 0.13.0 を使用します。
Zig には公式のバージョンマネージャが存在しないため、以下のいずれかの方法でインストールしてください。

### サードパーティのバージョンマネージャを使う

サードパーティ製の Zig バージョンマネージャのひとつに [tristanisham/zvm](https://github.com/tristanisham/zvm) があります。
GitHub の README から環境に合った方法で zvm をインストールした後、以下のコマンドで 0.13.0 をインストールします:

```bash
zvm install 0.13.0
zvm use 0.13.0
```

zvm にこだわる必要はないため、お好みのバージョンマネージャ[^1] を使ってください。

### 公式ページからバイナリをダウンロード

Zig の[リリースページ](https://ziglang.org/download/)から 0.13.0 のバイナリをダウンロードし、パスが通っているディレクトリに配置してください。

## ZLS

Zig の language server である [ZLS](https://github.com/zigtools/zls) を使用します。
様々なエディタで利用可能な拡張が存在するため、[Zigのツールガイド](https://ziglang.org/learn/tools/)に従って環境をセットアップしてください。

なお、使用する Zig のバージョンと ZLS のバージョンは必ず一致させてください[^2]。

## OVMF

[OVMF](https://github.com/tianocore/tianocore.github.io/wiki/OVMF) は VM 上で UEFI をサポートするプロジェクト[^3]です。
QEMU ではデフォルトで [SeaBIOS](https://www.seabios.org/SeaBIOS) と呼ばれるレガシーBIOSが使われますが、本シリーズでは OVMF を使って起動します。
使用する OVMF は、x64 アーキテクチャの 64bit モード起動をする `X64` ビルドを利用します。
これにより、ブートローダを [long mode](https://en.wikipedia.org/wiki/Long_mode) で実行することが可能になります。

Ubuntu を使っている場合には以下のコマンドでインストールできます:

```bash
sudo apt install ovmf
```

また、ソースコードからのビルドも可能です。
その場合には TianoCore の [GitHub Wiki](https://github.com/tianocore/tianocore.github.io/wiki/How-to-build-OVMF) の手順に従ってください。

[^1]: 例として、他には [zigup](https://github.com/marler8997/zigup) があります。
[^2]: バージョンを一致させないと ZLS が正常に動作しません (e.g. ["ZLS not pulling in information from dependencies"](https://ziggit.dev/t/zls-not-pulling-in-information-from-dependencies/4179))
[^3]: [Open Virtual Machine Firmware (OVMF) Status Report](https://access.redhat.com/articles/1434903)
