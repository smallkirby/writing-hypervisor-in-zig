# MSR の仮想化

本チャプターでは MSR を仮想化します。
ゲストに対して見せる MSR の値を任意に設定し、逆にゲストが MSR に書き込もうとした値をホストが変更することもできます。
また、VM Entry と VM Exit の際に MSR の値を適切に保存・復元するようにします。

> [!IMPORTANT]
>
> 本チャプターの最終コードは [`whiz-vmm-msr`](https://github.com/smallkirby/ymir/tree/whiz-vmm-msr) ブランチにあります。

## Table of Contents

<!-- toc -->

## VM Exit ハンドラ

ゲストが [RDMSR](https://www.felixcloutier.com/x86/rdmsr) / [WRMSR](https://www.felixcloutier.com/x86/wrmsr) 命令を実行しようとすると VM Exit が発生する場合があります。
VM Exit が発生するかどうかは VMCS Execution Control カテゴリの **MSR Bitmaps** によって制御されます。
MSR Bitmaps は MSR のアドレスにマップされるビットマップであり、値が `1` の MSR に対して RDMSR / WRMSR が実行されると VM Exit が発生します。
値が `0` の MSR に対する操作では VM Exit が発生しません。
また、**MSR Bitmaps を無効化すると全ての MSR に対する RDMSR/WRMSR が VM Exit を発生させる** ようになります。

本シリーズでは MSR Bitmaps を無効化し、全ての MSR に対する RDMSR/WRMSR が VM Exit を発生させるようにします:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
fn setupExecCtrls(vcpu: *Vcpu, _: Allocator) VmxError!void {
    ...
    ppb_exec_ctrl.use_msr_bitmap = false;
    ...
}
```

RDMSR は `31` / WRMSR は `32` 番の Exit Reason で VM Exit します。
それぞれについて Exit ハンドラを呼び出すように変更します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
const msr = @import("msr.zig");

fn handleExit(self: *Self, exit_info: vmx.ExitInfo) VmxError!void {
    switch (exit_info.basic_reason) {
        ...
        .rdmsr => {
            try msr.handleRdmsrExit(self);
            try self.stepNextInst();
        },
        .wrmsr => {
            try msr.handleWrmsrExit(self);
            try self.stepNextInst();
        },
    }
    ...
}
```

## MSR の保存・復帰

MSR アクセスに対する VM Exit ハンドラの実装の前に、VM Entry / VM Exit において MSR の保存・復帰をするようにしましょう。
現在は、一部の MSR を除いて全ての MSR はゲスト・ホスト間で共有されてしまっています。

### 自動的に保存・復帰される MSR

以下のゲストの MSR は VM Entry 時に対応する場所から自動的にロードされます:

| MSR | 条件 | ロード元 |
| --- | --- | --- |
| `IA32_DEBUGCTL` | VMCS VM-Entry Control の `load debug controls` が有効 | Guest-State |
| `IA32_SYSENTER_CS` | (Unconditional) | VMCS Guest-State |
| `IA32_SYSENTER_ESP` | (Unconditional) | VMCS Guest-State |
| `IA32_SYSENTER_EIP` | (Unconditional) | VMCS Guest-State |
| `IA32_FSBASE` | (Unconditional) | Guest-State の FS.Base |
| `IA32_GSBASE` | (Unconditional) | Guest-State の GS.Base |
| `IA32_PERF_GLOBAL_CTRL` | VMCS VM-Entry Control の `load IA32_PERF_GLOBAL_CTRL` が有効 | Guest-State |
| `IA32_PAT` | VMCS VM-Entry Control の `load IA32_PAT` が有効 | Guest-State |
| `IA32_EFER` | VMCS VM-Entry Control の `load IA32_EFER` が有効 | Guest-State |
| `IA32_BNDCFGS` | VMCS VM-Entry Control の `load IA32_BNDCFGS` が有効 | Guest-State |
| `IA32_RTIT_CTL` | VMCS VM-Entry Control の `load IA32_RTIT_CTL` が有効 | Guest-State |
| `IA32_S_CET` | VMCS VM-Entry Control の `load CET` が有効 | Guest-State |
| `IA32_INTERRUPT_SSP_TABLE_ADDR` | VMCS VM-Entry Control の `load CET` が有効 | Guest-State |
| `IA32_LBR_CTRL` | VMCS VM-Entry Control の `load IA32_LBR_CTRL` が有効 | Guest-State |
| `IA32_PKRS` | VMCS VM-Entry Control の `load PKRS` が有効 | Guest-State |

以下のホストの MSR は VM Exit 時に対応する場所から自動的にロードされます:

| MSR | 条件 | ロード元 |
| --- | --- | --- |
| `IA32_DEBUGCTL` | (Unconditional) | `0` にクリアされる |
| `IA32_SYSENTER_CS` | (Unconditional) | VMCS Host-State |
| `IA32_SYSENTER_ESP` | (Unconditional) | VMCS Host-State |
| `IA32_SYSENTER_EIP` | (Unconditional) | VMCS Host-State |
| `IA32_FSBASE` | (Unconditional) | Host-State の FS.Base |
| `IA32_GSBASE` | (Unconditional) | Host-State の GS.Base |
| `IA32_PERF_GLOBAL_CTRL` | VMCS VM-Exit Control の `load IA32_PERF_GLOBAL_CTRL` が有効 | Host-State |
| `IA32_PAT` | VMCS VM-Exit Control の `load IA32_PAT` が有効 | Host-State |
| `IA32_EFER` | VMCS VM-Exit Control の `load IA32_EFER` が有効 | Host-State |
| `IA32_BNDCFGS` | VMCS VM-Exit Control の `clear IA32_BNDCFGS` が有効 | `0` にクリアされる |
| `IA32_RTIT_CTL` | VMCS VM-Exit Control の `clear IA32_RTIT_CTL` が有効 | `0` にクリアされる |
| `IA32_S_CET` | VMCS VM-Exit Control の `load CET` が有効 | Host-State |
| `IA32_INTERRUPT_SSP_TABLE_ADDR` | VMCS VM-Exit Control の `load CET` が有効 | Host-State |
| `IA32_PKRS` | VMCS VM-Exit Control の `load PKRS` が有効 | Host-State |

以下のゲストの MSR は VM Exit 時に対応する場所に自動的にセーブされます:

| MSR | 条件 | セーブ先 |
| --- | --- | --- |
| `IA32_DEBUGCTL` | VMCS VM-Exit Control の `save debug controls` が有効 | Guest-State |
| `IA32_PAT` | VMCS VM-Exit Control の `save IA32_PAT` が有効 | Host-State |
| `IA32_EFER` | VMCS VM-Exit Control の `save IA32_EFER` が有効 | Host-State |
| `IA32_BNDCFGS` | VMCS VM-Exit Control の `load IA32_BNDCFGS` が有効 | Host-State |
| `IA32_RTIT_CTL` | VMCS VM-Exit Control の `load IA32_RTIT_CTL` が有効 | Host-State |
| `IA32_S_CET` | VMCS VM-Exit Control の `load CET` が有効 | Host-State |
| `IA32_INTERRUPT_SSP_TABLE_ADDR` | VMCS VM-Exit Control の `load CET` が有効 | Host-State |
| `IA32_LBR_CTRL` | VMCS VM-Exit Control の `load IA32_LBR_CTRL` が有効 | Host-State |
| `IA32_PKRS` | VMCS VM-Exit Control の `load PKRS` が有効 | Host-State |
| `IA32_PERF_GLOBAL_CTRL` | VMCS VM-Exit Control の `save IA32_PERF_GLOBAL_CTRL` が有効 | Host-State |

これらの MSR は VM Entry / VM Exit 時に自動的にセーブ・ロードされます。
ロードする値は VMCS に保存されているため、ホスト・ゲスト間で共有される心配がありません。
いくつかの MSR は VM-Exit/-Entry Controls において設定を有効化する必要があります。
Ymir では以下の MSR についてロードを有効化します。
上記の MSR の内、下記の MSR 以外は Ymir では使わないため、仮想化する必要がありません (ホストにいる間もゲストの MSR が見えることになります):

- `IA32_PAT`
- `IA32_EFER`

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
fn setupExitCtrls(_: *Vcpu) VmxError!void {
    ...
    exit_ctrl.load_ia32_efer = true;
    exit_ctrl.save_ia32_efer = true;
    exit_ctrl.load_ia32_pat = true;
    exit_ctrl.save_ia32_pat = true;
    ...
}

fn setupEntryCtrls(_: *Vcpu) VmxError!void {
    ...
    entry_ctrl.load_ia32_efer = true;
    entry_ctrl.load_ia32_pat = true;
    ...
}
```

### MSR Area

上記の MSR 以外は明示的に設定しない限り VM Entry / VM Exit 時に保存・復帰されません。
Ymir では以下の MSR について追加で保存・復帰をすることにします:

- `IA32_TSC_AUX`
- `IA32_STAR`
- `IA32_LSTAR`
- `IA32_CSTAR`
- `IA32_FMASK`
- `IA32_KERNEL_GS_BASE`

VM Exit / Entry 時にロード・セーブする MSR は **MSR Area** と呼ばれる領域に保存します。
MSR Area は **MSR Entry** と呼ばれる 128bit のエントリの配列です。
MSR Entry は以下のような構造を持ち、`index` で指定される MSR の `data` を保持します:

![Format of an MSR Entry](../assets/sdm/msr_entry.png)
*Format of an MSR Entry. SDM Vol.3C Table 25-15.*

MSR Area には以下の3種類があります:

- **VM-Entry MSR-Load Area**: VM Entry 時にゲストの MSR をロードするためのエリア
- **VM-Exit MSR-Store Area**: VM Exit 時にゲストの MSR を保存するためのエリア
- **VM-Exit MSR-Load Area**: VM Exit 時にホストの MSR をロードするためのエリア

VM Entry 時にホストの MSR をセーブするためのエリアは存在しません。
おそらく(当然ですが)ホストは virtualization-aware であるため、VM Entry する前に手動でセーブしろということでしょう。

MSR Area を表現する構造体を定義します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/msr.zig
const std = @import("std");
const Allocator = std.mem.Allocator;
const ymir = @import("ymir");
const mem = ymir.mem;
const am = @import("asm.zig");

pub const ShadowMsr = struct {
    /// Maximum number of MSR entries in a page.
    const max_num_ents = 512;

    /// MSR entries.
    ents: []SavedMsr,
    /// Number of registered MSR entries.
    num_ents: usize = 0,
    /// MSR Entry.
    pub const SavedMsr = packed struct(u128) {
        index: u32,
        reserved: u32 = 0,
        data: u64,
    };

    /// Initialize saved MSR page.
    pub fn init(allocator: Allocator) !ShadowMsr {
        const ents = try allocator.alloc(SavedMsr, max_num_ents);
        @memset(ents, std.mem.zeroes(SavedMsr));

        return ShadowMsr{
            .ents = ents,
        };
    }

    /// Register or update MSR entry.
    pub fn set(self: *ShadowMsr, index: am.Msr, data: u64) void {
        return self.setByIndex(@intFromEnum(index), data);
    }

    /// Register or update MSR entry indexed by `index`.
    pub fn setByIndex(self: *ShadowMsr, index: u32, data: u64) void {
        for (0..self.num_ents) |i| {
            if (self.ents[i].index == index) {
                self.ents[i].data = data;
                return;
            }
        }
        self.ents[self.num_ents] = SavedMsr{ .index = index, .data = data };
        self.num_ents += 1;
        if (self.num_ents > max_num_ents) {
            @panic("Too many MSR entries registered.");
        }
    }

    /// Get the saved MSRs.
    pub fn savedEnts(self: *ShadowMsr) []SavedMsr {
        return self.ents[0..self.num_ents];
    }

    /// Find the saved MSR entry.
    pub fn find(self: *ShadowMsr, index: am.Msr) ?*SavedMsr {
        const index_num = @intFromEnum(index);
        for (0..self.num_ents) |i| {
            if (self.ents[i].index == index_num) {
                return &self.ents[i];
            }
        }
        return null;
    }

    /// Get the host physical address of the MSR page.
    pub fn phys(self: *ShadowMsr) u64 {
        return mem.virt2phys(self.ents.ptr);
    }
};
```

`ShadowMsr` は MSR Entry の配列を保持し、登録する MSR を操作するための API を提供します。
3つの MSR Area のうち、ホスト用(Load)とゲスト用(Store+Load)の領域を表すメンバ変数を `Vm` に追加します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
pub const Vcpu = struct {
    host_msr: msr.ShadowMsr = undefined,
    guest_msr: msr.ShadowMsr = undefined,
    ...
}
```

VMCS の初期化時 (`setupVmcs()`) で、ゲストとホストの MSR Area を初期化します。
MSR Area の物理アドレスは VM-Exit Controls / VM-Entry Controls の `MSR-load address` / `MSR-store address` に設定します。
また、MSR Area に登録された MSR の個数は `MSR-load count` / `MSR-store count` に設定します。
ここに登録された MSR Area の先頭から `count` 分だけ、VM Exit / VM Entry 時にロード・セーブされます。
ホストの MSR は現在の MSR の値をそのまま登録することにします。
ゲストの MSR は全て `0` に初期化します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
fn registerMsrs(vcpu: *Vcpu, allocator: Allocator) !void {
    vcpu.host_msr = try msr.ShadowMsr.init(allocator);
    vcpu.guest_msr = try msr.ShadowMsr.init(allocator);

    const hm = &vcpu.host_msr;
    const gm = &vcpu.guest_msr;

    // Host MSRs.
    hm.set(.tsc_aux, am.readMsr(.tsc_aux));
    hm.set(.star, am.readMsr(.star));
    hm.set(.lstar, am.readMsr(.lstar));
    hm.set(.cstar, am.readMsr(.cstar));
    hm.set(.fmask, am.readMsr(.fmask));
    hm.set(.kernel_gs_base, am.readMsr(.kernel_gs_base));

    // Guest MSRs.
    gm.set(.tsc_aux, 0);
    gm.set(.star, 0);
    gm.set(.lstar, 0);
    gm.set(.cstar, 0);
    gm.set(.fmask, 0);
    gm.set(.kernel_gs_base, 0);

    // Init MSR data in VMCS.
    try vmwrite(vmcs.ctrl.exit_msr_load_address, hm.phys());
    try vmwrite(vmcs.ctrl.exit_msr_store_address, gm.phys());
    try vmwrite(vmcs.ctrl.entry_msr_load_address, gm.phys());
}

pub const Vcpu = struct {
    ...
    pub fn setupVmcs(self: *Self, allocator: Allocator) VmxError!void {
        ...
        try registerMsrs(self, allocator);
        ...
```

VM-Exit MSR-Load Area (VM Exit 時にホストの MSR にロードされる領域) は、VM Entry 前に毎回更新する必要があります。
そうしなければ、最初に設定した値が永遠に使われることになってしまいます。
VM Entry ループをする `loop()` 内の `while` ループの先頭で、以下の関数を呼び出します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/vcpu.zig
fn updateMsrs(vcpu: *Vcpu) VmxError!void {
    // Save host MSRs.
    for (vcpu.host_msr.savedEnts()) |ent| {
        vcpu.host_msr.setByIndex(ent.index, am.readMsr(@enumFromInt(ent.index)));
    }
    // Update MSR counts.
    try vmwrite(vmcs.ctrl.vexit_msr_load_count, vcpu.host_msr.num_ents);
    try vmwrite(vmcs.ctrl.exit_msr_store_count, vcpu.guest_msr.num_ents);
    try vmwrite(vmcs.ctrl.entry_msr_load_count, vcpu.guest_msr.num_ents);
}

pub const Vcpu = struct {
    ...
    pub fn loop(self: *Self) VmxError!void {
        while (true) {
            try updateMsrs(self);
            ...
```

本シリーズでは MSR Area に登録する MSR の個数が変わることはありません。
このあと扱いますが、ゲストが MSR Area に登録されていない MSR に対して WRMSR をしてきた場合にはアボートするようにします。
よって、実際は MSR counts を更新する必要はありません。
今後 MSR Area に動的に MSR を追加で登録できるようにしたい場合に備えて、このような実装にしています。

以上で MSR Area に登録した MSR 及び自動的に保存・復帰される MSR の設定が完了しました。
残すはゲストの RDMSR / WRMSR に応じて MSR Area に登録された MSR の値を読み書きする処理を実装することです。

## RDMSR ハンドラ

RDMSR に対するハンドラを実装します。
まずは、ゲストのレジスタに RDMSR の結果を格納するためのヘルパー関数を用意します。
RDMSR の結果は上位 32bit を RDX に、下位 32bit を RAX に格納します。
ゲストに MSR の値を見せるには以下の2つのパターンがあります:

- VMCS に登録された値を返す: 自動的にロード・セーブされる MSR の場合
- MSR Area に登録された値を返す: それ以外

前者のために `setRetVal()` を、後者のために `shadowRead()` を用意します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/msr.zig
const am = @import("../asm.zig");
const Vcpu = @import("vcpu.zig").Vcpu;
const log = std.log.scoped(.vcpu);

/// Concatnate two 32-bit values into a 64-bit value.
fn concat(r1: u64, r2: u64) u64 {
    return ((r1 & 0xFFFF_FFFF) << 32) | (r2 & 0xFFFF_FFFF);
}

/// Set the 64-bit return value to the guest registers.
fn setRetVal(vcpu: *Vcpu, val: u64) void {
    const regs = &vcpu.guest_regs;
    @as(*u32, @ptrCast(&regs.rdx)).* = @as(u32, @truncate(val >> 32));
    @as(*u32, @ptrCast(&regs.rax)).* = @as(u32, @truncate(val));
}

/// Read from the MSR Area.
fn shadowRead(vcpu: *Vcpu, msr_kind: am.Msr) void {
    if (vcpu.guest_msr.find(msr_kind)) |msr| {
        setRetVal(vcpu, msr.data);
    } else {
        log.err("RDMSR: MSR is not registered: {s}", .{@tagName(msr_kind)});
        vcpu.abort();
    }
}
```

以上を踏まえて、RDMSR ハンドラを実装します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/msr.zig
const vmx = @import("common.zig");
const VmxError = vmx.VmxError;
const vmcs = @import("vmcs.zig");

pub fn handleRdmsrExit(vcpu: *Vcpu) VmxError!void {
    const guest_regs = &vcpu.guest_regs;
    const msr_kind: am.Msr = @enumFromInt(guest_regs.rcx);

    switch (msr_kind) {
        .apic_base => setRetVal(vcpu, std.math.maxInt(u64)), // 無効
        .efer => setRetVal(vcpu, try vmx.vmread(vmcs.guest.efer)),
        .fs_base => setRetVal(vcpu, try vmx.vmread(vmcs.guest.fs_base)),
        .gs_base => setRetVal(vcpu, try vmx.vmread(vmcs.guest.gs_base)),
        .kernel_gs_base => shadowRead(vcpu, msr_kind),
        else => {
            log.err("Unhandled RDMSR: {?}", .{msr_kind});
            vcpu.abort();
        },
    }
}
```

注: まだ定義していない場合、`Msr.apic_base` は 0x001B、`Msr.kernel_gs_base` は 0xC0000102 です。

対応していない MSR (`else`) に対する RDMSR はアボートします。
対応する必要のある MSR は経験則で決めています。
`else` だけをもつ `switch` でゲストを動かしてみて、Linux がブートするまでに必要な MSR を追加していったらこうなりました。
意外と少ない数の MSR で Linux が動くものですね。びっくり。
びっくりと言えば、この節を書いているのは11月です。
栗が美味しい季節になりましたね。

## WRMSR ハンドラ

RDMSR と同様にヘルパー関数を用意します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/msr.zig
fn shadowWrite(vcpu: *Vcpu, msr_kind: am.Msr) void {
    const regs = &vcpu.guest_regs;
    if (vcpu.guest_msr.find(msr_kind)) |_| {
        vcpu.guest_msr.set(msr_kind, concat(regs.rdx, regs.rax));
    } else {
        log.err("WRMSR: MSR is not registered: {s}", .{@tagName(msr_kind)});
        vcpu.abort();
    }
}
```

WRMSR ハンドラを実装します:

<!-- i18n:skip -->
```ymir/arch/x86/vmx/msr.zig
pub fn handleWrmsrExit(vcpu: *Vcpu) VmxError!void {
    const regs = &vcpu.guest_regs;
    const value = concat(regs.rdx, regs.rax);
    const msr_kind: am.Msr = @enumFromInt(regs.rcx);

    switch (msr_kind) {
        .star,
        .lstar,
        .cstar,
        .tsc_aux,
        .fmask,
        .kernel_gs_base,
        => shadowWrite(vcpu, msr_kind),
        .sysenter_cs => try vmx.vmwrite(vmcs.guest.sysenter_cs, value),
        .sysenter_eip => try vmx.vmwrite(vmcs.guest.sysenter_eip, value),
        .sysenter_esp => try vmx.vmwrite(vmcs.guest.sysenter_esp, value),
        .efer => try vmx.vmwrite(vmcs.guest.efer, value),
        .gs_base => try vmx.vmwrite(vmcs.guest.gs_base, value),
        .fs_base => try vmx.vmwrite(vmcs.guest.fs_base, value),
        else => {
            log.err("Unhandled WRMSR: {?}", .{msr_kind});
            vcpu.abort();
        },
    }
}
```

RDMSR よりは対応する必要のある MSR が多いです。
`STAR` / `LSTAR` / `CSTAR` (syscall のエントリポイント) などはセットするだけして読むことはないので、当然といえば当然ですね。

<details>
<summary>新しい `Msr` エントリを忘れないでください:</summary>

```ymir/arch/x86/asm.zig
pub const Msr = enum(u32) {
    ...
    sysenter_cs = 0x174,
    sysenter_esp = 0x175,
    sysenter_eip = 0x176,
    star = 0xC0000081,
    lstar = 0xC0000082,
    cstar = 0xC0000083,
    fmask = 0xC0000084,
    tsc_aux = 0xC0000103,
};
```

</details>

## まとめ

本チャプターでは、MSR Area を設定することで VM Entry / VM Exit 時にゲスト・ホストの MSR を適切に保存・復帰するように設定しました。
これによって、ホストとゲスト間の MSR 空間が分離されます。
また、RDMSR / WRMSR ハンドラを実装して VMCS または MSR Area に登録された値を読み書きするようにしました。
これによって MSR の仮想化ができたことになります。

もはや恒例になってきましたが、最後にゲストを動かしてみましょう:

<!-- i18n:skip -->
```txt
[INFO ] main    | Entered VMX root operation.
[INFO ] vmx     | Guest memory region: 0x0000000000000000 - 0x0000000006400000
[INFO ] vmx     | Guest kernel code offset: 0x0000000000005000
[DEBUG] ept     | EPT Level4 Table @ FFFF88800000E000
[INFO ] vmx     | Guest memory is mapped: HVA=0xFFFF888000A00000 (size=0x6400000)
[INFO ] main    | Setup guest memory.
[INFO ] main    | Starting the virtual machine...
No EFI environment detected.
early console in extract_kernel
input_data: 0x0000000002d582b9
input_len: 0x0000000000c7032c
output: 0x0000000001000000
output_len: 0x000000000297e75c
kernel_total_size: 0x0000000002630000
needed_size: 0x0000000002a00000
trampoline_32bit: 0x0000000000000000


KASLR disabled: 'nokaslr' on cmdline.


Decompressing Linux... Parsing ELF... No relocation needed... done.
Booting the kernel (entry_offset: 0x0000000000000000).
[ERROR] vcpu    | Unhandled VM-exit: reason=arch.x86.vmx.common.ExitReason.triple_fault
[ERROR] vcpu    | === vCPU Information ===
[ERROR] vcpu    | [Guest State]
[ERROR] vcpu    | RIP: 0xFFFFFFFF8102E0B9
[ERROR] vcpu    | RSP: 0x0000000002A03F58
[ERROR] vcpu    | RAX: 0x00000000032C8000
[ERROR] vcpu    | RBX: 0x0000000000000800
[ERROR] vcpu    | RCX: 0x0000000000000030
[ERROR] vcpu    | RDX: 0x0000000000001060
[ERROR] vcpu    | RSI: 0x00000000000001E3
[ERROR] vcpu    | RDI: 0x000000000000001C
[ERROR] vcpu    | RBP: 0x0000000001000000
[ERROR] vcpu    | R8 : 0x000000000000001C
[ERROR] vcpu    | R9 : 0x0000000000000008
[ERROR] vcpu    | R10: 0x00000000032CB000
[ERROR] vcpu    | R11: 0x000000000000001B
[ERROR] vcpu    | R12: 0x0000000000000000
[ERROR] vcpu    | R13: 0x0000000000000000
[ERROR] vcpu    | R14: 0x0000000000000000
[ERROR] vcpu    | R15: 0x0000000000010000
[ERROR] vcpu    | CR0: 0x0000000080050033
[ERROR] vcpu    | CR3: 0x00000000032C8000
[ERROR] vcpu    | CR4: 0x0000000000002020
[ERROR] vcpu    | EFER:0x0000000000000500
[ERROR] vcpu    | CS : 0x0010 0x0000000000000000 0xFFFFFFFF
```

なんと！
ついにゲストからのログが出力されました！
まだカーネルの本体がブートする前ですが、[Linux Boot Protocol のチャプター](./linux_boot.md) でコマンドラインに `earlyprintk=serial` を出力したのでログが出力されています[^log]。
`'nokaslr' on cmdline` と出力されているように、`BootParams` で指定したコマンドラインもちゃんとゲストに渡っていることが分かりますね。

`Decompressing Linux...` は [extract_kernel()](https://github.com/torvalds/linux/blob/2d5404caa8c7bb5c4e0435f94b28834ae5456623/arch/x86/boot/compressed/misc.c#L405) からの出力です。
この関数は `head_64.S` の [relocated()](https://github.com/torvalds/linux/blob/2d5404caa8c7bb5c4e0435f94b28834ae5456623/arch/x86/boot/compressed/head_64.S#L477) から呼ばれます。
圧縮されたカーネルを展開してメモリに展開し、制御を移そうとする関数です。
ここで展開されたカーネルは `BootParams` で指定したアドレス (`0x10_0000`) に展開されます。
`extract_kernel()` の直後にこのアドレスにジャンプし、`compress/head_64.S` ではない方の `head_64.S` の [startup_64()](https://github.com/torvalds/linux/blob/2d5404caa8c7bb5c4e0435f94b28834ae5456623/arch/x86/kernel/head_64.S#L38) に制御が移ります。

最終的に発生している Triple Fault は、CR4 の PSE ビットをセットしようとしている部分です:

<!-- i18n:skip -->
```arch/x86/kernel/head_64.S
ffffffff8102e0a8 <common_startup_64>:
ffffffff8102e0a8:       ba 20 10 00 00          mov    edx,0x1020
ffffffff8102e0ad:       83 ca 40                or     edx,0x40
ffffffff8102e0b0:       0f 20 e1                mov    rcx,cr4
ffffffff8102e0b3:       21 d1                   and    ecx,edx
ffffffff8102e0b5:       0f ba e9 04             bts    ecx,0x4
ffffffff8102e0b9:       0f 22 e1                mov    cr4,rcx
ffffffff8102e0bc:       0f ba e9 07             bts    ecx,0x7
```

この `MOV to CR4` は、`CR4.VMXE` ビットをアンセットしてしまいます。
**VM Exit を引き起こさないような `MOV to CR4` が `IA32_VMX_CR4_FIXED0` または `IA32_VMX_CR4_FIXED1` で規定される CR4 のルールに従っていない場合、ゲスト側で `#GP` が発生します** (VM Exit ではありません)。[^cr4-gp]。
ゲストにはまだ割り込みハンドラがないため、`#GP` が発生するとそのまま Triple Faults になってしまうようです。
ということで、次回はゲストによる CR アクセスを適切にハンドリングするようにしましょう。

[^log]: まだシリアルコンソールの仮想化はしていないため、ゲストは直接シリアルを触りにいっています。今はまだ許してあげることにしましょう。
[^cr4-gp]: *SDM Vol.3C 26.3 CHANGES TO INSTRUCTION BEHAVIOR IN VMX NON-ROOT OPERATION*
