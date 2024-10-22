# Writing Hypervisor in Zig

![Ymir](assets/ymir.png)
*Ymir, the Type-1 Baremetal Hypervisor*

## References

本シリーズにおける主な参考文献は [Intel® 64 and IA-32 Architectures Software Developer Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) です。
以降は **SDM** と略して表記します。
SDM から抜粋した画像については、キャプションに *"SDM Vol.\<Volume\> \<Chapter\>.\<Section\>.\<Subsection\>"* と表記します。
SDM から抜粋した画像は全て [© Intel Corporation](https://www.intel.com/) に帰属します。

SDM 以外には、以下の情報を参考にしています:

- [BitVisor](https://www.bitvisor.org/)
- [ZystemOS/pluto: An x86 kernel written in Zig](https://github.com/ZystemOS/pluto)
- [AndreaOrru/zen : Experimental operating system written in Zig](https://github.com/AndreaOrru/zen)
- [nuta/resea: A microkernel-based hackable operating system.](https://github.com/nuta/resea)
- [ハイパーバイザの作り方](https://syuu1228.github.io/howto_implement_hypervisor/)
- [ゼロからの OS 自作入門](https://zero.osdev.jp/)
- [5 Days to Virtualization: A Series on Hypervisor Development - Reverse Engineering](https://revers.engineering/7-days-to-virtualization-a-series-on-hypervisor-development/)
- [Hypervisor From Scratch - Rayanfam Blog](https://rayanfam.com/topics/hypervisor-from-scratch-part-1/)
- [Writing OS in Rust](https://os.phil-opp.com)

その他局所的に参考にした情報については各ページに記載します。

## Changelog

TODO
