# Summary

[Writing Hypervisor in Zig](intro.md)
[環境構築](setup.md)

# Bootloader

- [Hello UEFI](bootloader/hello_uefi.md)
- [ログ出力](bootloader/uefi_log.md)
- [カーネルのパース](bootloader/parse_kernel.md)
- [簡易ページテーブル](bootloader/simple_pg.md)
- [カーネルのロード](bootloader/load_kernel.md)
- [メモリマップとお片付け](bootloader/cleanup_memmap.md)
- [カーネルの起動](bootloader/jump_to_ymir.md)

# Ymir Kernel

- [シリアル出力](kernel/serial_output.md)
- [ビット演算とテスト](kernel/bit_and_test.md)
- [シリアルログシステム](kernel/serial_logsystem.md)
- [GDT](kernel/gdt.md)
- [割り込みと例外](kernel/interrupt.md)
- [Page Allocator](kernel/page_allocator.md)
- [ページング](kernel/paging.md)
- [パニック](kernel/panic.md)
- [General Allocator](kernel/general_allocator.md)
- [PIC](kernel/pic.md)

# Ymir VMM

- [VMX Root Operation](vmm/vmx_root.md)
- [VMCSの基礎](vmm/vmcs.md)
- [VMLAUNCH](vmm/vmlaunch.md)
- [VM-Entry / VM-Exit](vmm/vmentry_vmexit.md)
- [EPT](vmm/ept.md)
- [Linux Boot Protocol](vmm/linux_boot.md)
- [CPUID](vmm/cpuid.md)
- [MSR](vmm/msr.md)
- [Control Registers](vmm/cr.md)
- [I/O](vmm/io.md)
- [割り込みの注入](vmm/intr_injection.md)
- [initramfs](vmm/initramfs.md)
- [VMCALL](vmm/vmcall.md)

[謝辞](acknowledgement.md)
[ライセンス](license.md)
