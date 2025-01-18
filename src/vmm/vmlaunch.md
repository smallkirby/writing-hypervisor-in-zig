# VMLAUNCH: Restricted Guest の実行

前チャプターでは VMCS を現在のコアにセットし、中身は未設定のまま VMLAUNCH をしてエラーが発生することを確認しました。
本チャプターでは VMCS を適切に設定して VMLAUNCH を実行します。
それにより VMX Non-root Operation でゲストが実行できることを目標とします。

> [!IMPORTANT]
> 本チャプターの最終コードは [`whiz-vmm-vmlaunch`](https://github.com/smallkirby/ymir/tree/whiz-vmm-vmlaunch) ブランチにあります。

## Table of Contents

<!-- toc -->

## 本チャプターの概要

本シリーズの最終的な目標は Linux をブートし、シェルを動かすことです。
しかし、いきなり Linux が動くように設定することは難しいため、本チャプターではとりあえずゲストに遷移することを目標にします。
ゲストに遷移するためには VMCS の6カテゴリの内、read-only な VM-Exit Information カテゴリを除く5カテゴリを適切に設定する必要があります。

まずは本チャプターにおいてゲストとして実行する関数を定義します:

```ymir/arch/x86/vmx/vcpu.zig
export fn blobGuest() callconv(.Naked) noreturn {
    while (true) asm volatile ("hlt");
}
```

Calling Convention は `.Naked` にしています。
本チャプターではゲストに有効な RSP を設定しないため、関数のプロローグで RSP への PUSH 等が行われるとフォルトが発生してしまうためです。
この関数はただひたすらに HLT ループをします。
面白みのない関数ですが、これで VMX Non-root Operation に遷移できるかどうかを確かめていきます。

ページングやセグメンテーションに関して、本チャプターで扱うゲストでは以下の設定で動作させます。
感覚としてはゲストを動かすと言うよりも **Ymir をそのまま VMX Non-root Operation に遷移させるような感じ**です:

- **Restricted Guest**: ページングをすることが強制されるモード
- IA-32e 64bit mode (Long Mode)
- GDT / ページテーブル はホストと共有する
- その他の重要なレジスタ等についてもホストと共有する

## VM-Execution Control

まずは VM-Execution Control カテゴリを設定します。
これは VMX Non-root Operation におけるプロセッサの挙動を制御するフィールドです。
本チャプターでは Execution Control における2つのフィールドを設定します。

### Pin-Based Controls

**Pin-Based VM-Execution Controls**[^pbec] (以下 *Pin-Based Controls*) は例外などの非同期イベントを制御する 32bit のデータ構造です:

```ymir/arch/x86/vmx/vmcs.zig
pub const PinExecCtrl = packed struct(u32) {
    const Self = @This();

    external_interrupt: bool,
    _reserved1: u2,
    nmi: bool,
    _reserved2: u1,
    virtual_nmi: bool,
    activate_vmx_preemption_timer: bool,
    process_posted_interrupts: bool,
    _reserved3: u24,

    pub fn new() Self {
        return std.mem.zeroes(Self);
    }

    pub fn load(self: Self) VmxError!void {
        const val: u32 = @bitCast(self);
        try vmx.vmwrite(ctrl.pin_exec_ctrl, val);
    }

    pub fn store() VmxError!Self {
        const val: u32 = @truncate(try vmx.vmread(ctrl.pin_exec_ctrl));
        return @bitCast(val);
    }
};
```

各フィールドの意味は実際にそのフィールドを使うときが来たら説明します。
この構造体には、VMCS から値を取得またはセットするためのメソッド `load()` / `store()` を定義しています。

`ctrl` 列挙型は [Github](https://github.com/smallkirby/ymir/blob/whiz-vmm-vmlaunch/ymir/arch/x86/vmx/vmcs.zig) にあります。

<details>
<summary>またはこちら。</summary>

```ymir/arch/x86/vmx/vmcs.zig
pub const ctrl = enum(u32) {
    // Natural-width fields.
    cr0_mask = ec(0, .full, .natural),
    cr4_mask = ec(1, .full, .natural),
    cr0_read_shadow = ec(2, .full, .natural),
    cr4_read_shadow = ec(3, .full, .natural),
    cr3_target0 = ec(4, .full, .natural),
    cr3_target1 = ec(5, .full, .natural),
    cr3_target2 = ec(6, .full, .natural),
    cr3_target3 = ec(7, .full, .natural),
    // 16-bit fields.
    vpid = ec(0, .full, .word),
    posted_intr_notif_vector = ec(1, .full, .word),
    eptp_index = ec(2, .full, .word),
    hlat_prefix_size = ec(3, .full, .word),
    pid_pointer_index = ec(4, .full, .word),
    // 32-bit fields.
    pin_exec_ctrl = ec(0, .full, .dword),
    proc_exec_ctrl = ec(1, .full, .dword),
    exception_bitmap = ec(2, .full, .dword),
    pf_ec_mask = ec(3, .full, .dword),
    pf_ec_match = ec(4, .full, .dword),
    cr3_target_count = ec(5, .full, .dword),
    primary_exit_ctrl = ec(6, .full, .dword),
    exit_msr_store_count = ec(7, .full, .dword),
    vexit_msr_load_count = ec(8, .full, .dword),
    entry_ctrl = ec(9, .full, .dword),
    entry_msr_load_count = ec(10, .full, .dword),
    entry_intr_info = ec(11, .full, .dword),
    entry_exception_ec = ec(12, .full, .dword),
    entry_inst_len = ec(13, .full, .dword),
    tpr_threshold = ec(14, .full, .dword),
    secondary_proc_exec_ctrl = ec(15, .full, .dword),
    ple_gap = ec(16, .full, .dword),
    ple_window = ec(17, .full, .dword),
    instruction_timeouts = ec(18, .full, .dword),
    // 64-bit fields.
    io_bitmap_a = ec(0, .full, .qword),
    io_bitmap_b = ec(1, .full, .qword),
    msr_bitmap = ec(2, .full, .qword),
    exit_msr_store_address = ec(3, .full, .qword),
    exit_msr_load_address = ec(4, .full, .qword),
    entry_msr_load_address = ec(5, .full, .qword),
    executive_vmcs_pointer = ec(6, .full, .qword),
    pml_address = ec(7, .full, .qword),
    tsc_offset = ec(8, .full, .qword),
    virtual_apic_address = ec(9, .full, .qword),
    apic_access_address = ec(10, .full, .qword),
    posted_intr_desc_addr = ec(11, .full, .qword),
    vm_function_controls = ec(12, .full, .qword),
    eptp = ec(13, .full, .qword),
    eoi_exit_bitmap0 = ec(14, .full, .qword),
    eoi_exit_bitmap1 = ec(15, .full, .qword),
    eoi_exit_bitmap2 = ec(16, .full, .qword),
    eoi_exit_bitmap3 = ec(17, .full, .qword),
    eptp_list_address = ec(18, .full, .qword),
    vmread_bitmap = ec(19, .full, .qword),
    vmwrite_bitmap = ec(20, .full, .qword),
    vexception_information_address = ec(21, .full, .qword),
    xss_exiting_bitmap = ec(22, .full, .qword),
    encls_exiting_bitmap = ec(23, .full, .qword),
    sub_page_permission_table_pointer = ec(24, .full, .qword),
    tsc_multiplier = ec(25, .full, .qword),
    tertiary_proc_exec_ctrl = ec(26, .full, .qword),
    enclv_exiting_bitmap = ec(27, .full, .qword),
    low_pasid_directory = ec(28, .full, .qword),
    high_pasid_directory = ec(29, .full, .qword),
    shared_eptp = ec(30, .full, .qword),
    pconfig_exiting_bitmap = ec(31, .full, .qword),
    hlatp = ec(32, .full, .qword),
    pid_pointer_table = ec(33, .full, .qword),
    secondary_exit_ctrl = ec(34, .full, .qword),
    spec_ctrl_mask = ec(37, .full, .qword),
    spec_ctrl_shadow = ec(38, .full, .qword),
};
```

</details>

Execution Control を設定する関数において Pin-Based Controls を設定します:

```ymir/arch/x86/vmx/vcpu.zig
fn setupExecCtrls(_: *Vcpu, _: Allocator) VmxError!void {
    const basic_msr = am.readMsrVmxBasic();

    // Pin-based VM-Execution control.
    const pin_exec_ctrl = try vmcs.PinExecCtrl.store();
    try adjustRegMandatoryBits(
        pin_exec_ctrl,
        if (basic_msr.true_control) am.readMsr(.vmx_true_pinbased_ctls) else am.readMsr(.vmx_pinbased_ctls),
    ).load();
    ...
}
```

注意: `IA32_VMX_PINBASED_CTRLS` と `IA32_VMX_TRUE_PINBASED_CTRLS` の値はそれぞれ 0x0481 と 0x048D です。

本チャプターではまだ非同期イベントを扱わないため、Pin-Based Controls はデフォルトの値を使用します。

VMCS に書き込む値には **Reserved Bits** が多くあります。
Reserved Bits は単にゼロクリアすれば良いわけではありません。
**フィールドごとに適切な MSR を参照し、その値をもとにして Reserved Bits を設定する必要**があります。
Pin-Based Controls では、`IA32_VMX_BASIC` MSR の 55-th bit (`.true_control`) の値に応じて
`IA32_VMX_PINBASED_CTRLS` または `IA32_VMX_TRUE_PINBASED_CTRLS` の値を使用します。
これらの MSR は Pin-Based Controls に対して以下のような制約を課します:

- **[31:0]: Allowed 0-settings**: MSR のビットが `1` である場合、VMCS フィールドの該当ビットは `1` でなければならない (*Manadatory 1*)
- **[63:32]: Allowed 1-settings**: MSR のビットが `0` である場合、VMCS フィールドの該当ビットは `0` でなければならない (*Manadatory 0*)

今後も *Allowed 0/1-settings* は頻繁に登場するため、VMCS フィールドに対してこれらの settings を適用するヘルパー関数を用意します:

```ymir/arch/x86/vmx/vcpu.zig
fn adjustRegMandatoryBits(control: anytype, mask: u64) @TypeOf(control) {
    var ret: u32 = @bitCast(control);
    ret |= @as(u32, @truncate(mask)); // Mandatory 1
    ret &= @as(u32, @truncate(mask >> 32)); // Mandatory 0
    return @bitCast(ret);
}
```

`setupExecCtrls()` ではこのヘルパー関数を使い、`IA32_VMX_PINBASED_CTRLS` または `IA32_VMX_TRUE_PINBASED_CTRLS` が課す制約を Pin-Based Controls に適用しています。

### Primary Processor-Based Controls

**Processor-Based VM-Execution Controls**[^pp] (以下 *Processor-Based Controls*) は同期イベント(特定の命令の実行など) を制御するデータ構造です。
**Primary Processor-Based Controls** (32bits) と **Secondary Processor-Based Controls** (64bits) の2つがあります。
本チャプターでは Primary の方だけを設定します:

```ymir/arch/x86/vmx/vmcs.zig
pub const PrimaryProcExecCtrl = packed struct(u32) {
    const Self = @This();

    _reserved1: u2,
    interrupt_window: bool,
    tsc_offsetting: bool,
    _reserved2: u3,
    hlt: bool,
    _reserved3: u1,
    invlpg: bool,
    mwait: bool,
    rdpmc: bool,
    rdtsc: bool,
    _reserved4: u2,
    cr3load: bool,
    cr3store: bool,
    activate_teritary_controls: bool,
    _reserved: u1,
    cr8load: bool,
    cr8store: bool,
    use_tpr_shadow: bool,
    nmi_window: bool,
    mov_dr: bool,
    unconditional_io: bool,
    use_io_bitmap: bool,
    _reserved5: u1,
    monitor_trap: bool,
    use_msr_bitmap: bool,
    monitor: bool,
    pause: bool,
    activate_secondary_controls: bool,

    pub fn load(self: Self) VmxError!void {
        const val: u32 = @bitCast(self);
        try vmx.vmwrite(ctrl.proc_exec_ctrl, val);
    }

    pub fn store() VmxError!Self {
        const val: u32 = @truncate(try vmx.vmread(ctrl.proc_exec_ctrl));
        return @bitCast(val);
    }
};
```

同様に `setupExecCtrls()` で Primary Processor-Based Controls を設定します:

```ymir/arch/x86/vmx/vcpu.zig
fn setupExecCtrls(_: *Vcpu, _: Allocator) VmxError!void {
    ...
    var ppb_exec_ctrl = try vmcs.PrimaryProcExecCtrl.store();
    ppb_exec_ctrl.hlt = false;
    ppb_exec_ctrl.activate_secondary_controls = false;
    try adjustRegMandatoryBits(
        ppb_exec_ctrl,
        if (basic_msr.true_control) am.readMsr(.vmx_true_procbased_ctls) else am.readMsr(.vmx_procbased_ctls),
    ).load();
}
```

`.hlt` は [HLT](https://www.felixcloutier.com/x86/hlt) 命令時に VMExit するかどうかを設定します。
今回は `blobGuest()` で HLT ループをしたいため、`false` に設定します。
`.activate_secondary_controls` は Secondary Processor-Based Controls を有効にするかどうかを設定します。
今回は Primary Processor-Based Controls のみを使いたいため、`false` に設定します。

Pin-Based Controls と同様に、Reserved Bits は MSR を参照して設定する必要があります。
利用する MSR は `IA32_VMX_PROCBASED_CTRLS` または `IA32_VMX_TRUE_PROCBASED_CTRLS` のどちらかです。
値はそれぞれ0x0482と0x048Eです。

## Host-State

続いて Host-State カテゴリを設定します。
このカテゴリは VM Exit した際のホストの状態を制御します。

### Control Registers

Control Registers は VM Exit した際の CR0, CR3, CR4 の値を制御します。
本シリーズでは VM Exit 後のホストの状態は VMLAUNCH 直前の状態と同じにしたいため、現在のホストの状態をそのまま設定します:

```ymir/arch/x86/vmx/vcpu.zig
fn setupHostState(_: *Vcpu) VmxError!void {
    // Control registers.
    try vmwrite(vmcs.host.cr0, am.readCr0());
    try vmwrite(vmcs.host.cr3, am.readCr3());
    try vmwrite(vmcs.host.cr4, am.readCr4());
    ...
}
```

### RIP / RSP

この2つのフィールドは VM Exit 直後に VMM のレジスタにセットされ、実行コンテキストを復元します。
今はとりあえずゲストを動かすことが目標であるため、一時的な値をセットします:

```ymir/arch/x86/vmx/vcpu.zig
    // RSP / RIP
    try vmwrite(vmcs.host.rip, &vmexitBootstrapHandler);
    try vmwrite(vmcs.host.rsp, @intFromPtr(&temp_stack) + temp_stack_size);
```

`vmexitBootstrapHandler()` は簡易的な VM Exit ハンドラです。
とりあえずログ出力と **VM Exit Reason** だけを出力して HLT ループに入ります。
VMM はまだレジスタの復元をしていないことに注意してください。
この関数が呼び出された時点で RBP やその他の汎用レジスタは一切セットされていません。
そのため、この関数は関数のプロローグを消すために `.Naked` calling convention を使っています:

```ymir/arch/x86/vmx/vcpu.zig
const temp_stack_size: usize = mem.page_size;
var temp_stack: [temp_stack_size + 0x10]u8 align(0x10) = [_]u8{0} ** (temp_stack_size + 0x10);

fn vmexitBootstrapHandler() callconv(.Naked) noreturn {
    asm volatile (
        \\call vmexitHandler
    );
}

export fn vmexitHandler() noreturn {
    log.debug("[VMEXIT handler]", .{});
    const reason = vmcs.ExitInfo.load() catch unreachable;
    log.debug("   VMEXIT reason: {?}", .{reason});
    while (true) asm volatile ("hlt");
}
```

`ExitInfo` は VM Exit Reason を表す `enum` です。
VM Exit が発生すると、その原因は VMCS VM-Exit Information カテゴリの Basic VM-Exit Information フィールドに格納されます。
この値を確認することで、VM Exit の大まかな原因が特定できます。
`load()` はこのフィールドから値を取得します。
実装が気になる人は以下を展開して確認してください:

<details>
<summary>VM Exit Reason and Host</summary>

```ymir/arch/x86/vmx/vmcs.zig
pub const ExitInfo = packed struct(u32) {
    basic_reason: ExitReason,
    _zero: u1 = 0,
    _reserved1: u10 = 0,
    _one: u1 = 1,
    pending_mtf: u1 = 0,
    exit_vmxroot: bool,
    _reserved2: u1 = 0,
    entry_failure: bool,

    pub fn load() VmxError!ExitInfo {
        return @bitCast(@as(u32, @truncate(try vmx.vmread(ro.vmexit_reason))));
    }
};

pub const ExitReason = enum(u16) {
    exception_nmi = 0,
    extintr = 1,
    triple_fault = 2,
    init = 3,
    sipi = 4,
    io_intr = 5,
    other_smi = 6,
    intr_window = 7,
    nmi_window = 8,
    task_switch = 9,
    cpuid = 10,
    getsec = 11,
    hlt = 12,
    invd = 13,
    invlpg = 14,
    rdpmc = 15,
    rdtsc = 16,
    rsm = 17,
    vmcall = 18,
    vmclear = 19,
    vmlaunch = 20,
    vmptrld = 21,
    vmptrst = 22,
    vmread = 23,
    vmresume = 24,
    vmwrite = 25,
    vmxoff = 26,
    vmxon = 27,
    cr = 28,
    dr = 29,
    io = 30,
    rdmsr = 31,
    wrmsr = 32,
    entry_fail_guest = 33,
    entry_fail_msr = 34,
    mwait = 36,
    monitor_trap = 37,
    monitor = 39,
    pause = 40,
    entry_fail_mce = 41,
    tpr_threshold = 43,
    apic = 44,
    veoi = 45,
    gdtr_idtr = 46,
    ldtr_tr = 47,
    ept = 48,
    ept_misconfig = 49,
    invept = 50,
    rdtscp = 51,
    preemption_timer = 52,
    invvpid = 53,
    wbinvd_wbnoinvd = 54,
    xsetbv = 55,
    apic_write = 56,
    rdrand = 57,
    invpcid = 58,
    vmfunc = 59,
    encls = 60,
    rdseed = 61,
    page_log_full = 62,
    xsaves = 63,
    xrstors = 64,
    pconfig = 65,
    spp = 66,
    umwait = 67,
    tpause = 68,
    loadiwkey = 69,
    enclv = 70,
    enqcmd_pasid_fail = 72,
    enqcmds_pasid_fail = 73,
    bus_lock = 74,
    timeout = 75,
    seamcall = 76,
    tdcall = 77,
};

pub const host = enum(u32) {
    // Natural-width fields.
    cr0 = eh(0, .full, .natural),
    cr3 = eh(1, .full, .natural),
    cr4 = eh(2, .full, .natural),
    fs_base = eh(3, .full, .natural),
    gs_base = eh(4, .full, .natural),
    tr_base = eh(5, .full, .natural),
    gdtr_base = eh(6, .full, .natural),
    idtr_base = eh(7, .full, .natural),
    sysenter_esp = eh(8, .full, .natural),
    sysenter_eip = eh(9, .full, .natural),
    rsp = eh(10, .full, .natural),
    rip = eh(11, .full, .natural),
    s_cet = eh(12, .full, .natural),
    ssp = eh(13, .full, .natural),
    intr_ssp_table_addr = eh(14, .full, .natural),
    // 16-bit fields.
    es_sel = eh(0, .full, .word),
    cs_sel = eh(1, .full, .word),
    ss_sel = eh(2, .full, .word),
    ds_sel = eh(3, .full, .word),
    fs_sel = eh(4, .full, .word),
    gs_sel = eh(5, .full, .word),
    tr_sel = eh(6, .full, .word),
    // 32-bit fields.
    sysenter_cs = eh(0, .full, .dword),
    // 64-bit fields.
    pat = eh(0, .full, .qword),
    efer = eh(1, .full, .qword),
    perf_global_ctrl = eh(2, .full, .qword),
    pkrs = eh(3, .full, .qword),
};
```

</details>

### セグメントレジスタ

セグメントレジスタは以下の2つの種類を設定します:

- CS / SS / DS / ES / FS / GS / TR のセグメントセレクタ
- FS / GS / TR / GDTR / IDTR の Base (LDTRの設定は無い)

一部のセグメントレジスタはセレクタのみを指定し、それ以外は Base も含めて設定することに注意してください。
[GDTのチャプター](../kernel/gdt.md) で説明したようにアドレス変換に使われることのないセグメントレジスタ(前者)ではセレクタのみを設定し、
実際にアドレス変換に使われる場合には Base まで指定するという区別であると推測されます。
GDTR / IDTR はそもそも Base しか持たないため、セレクタは指定できません:

```ymir/arch/x86/vmx/vcpu.zig
fn setupHostState(_: *Vcpu) VmxError!void {
    ...
    // Segment registers.
    try vmwrite(vmcs.host.cs_sel, am.readSegSelector(.cs));
    try vmwrite(vmcs.host.ss_sel, am.readSegSelector(.ss));
    try vmwrite(vmcs.host.ds_sel, am.readSegSelector(.ds));
    try vmwrite(vmcs.host.es_sel, am.readSegSelector(.es));
    try vmwrite(vmcs.host.fs_sel, am.readSegSelector(.fs));
    try vmwrite(vmcs.host.gs_sel, am.readSegSelector(.gs));
    try vmwrite(vmcs.host.tr_sel, am.readSegSelector(.tr));

    try vmwrite(vmcs.host.fs_base, am.readMsr(.fs_base));
    try vmwrite(vmcs.host.gs_base, am.readMsr(.gs_base));
    try vmwrite(vmcs.host.tr_base, 0); // Not used in Ymir.
    try vmwrite(vmcs.host.gdtr_base, am.sgdt().base);
    try vmwrite(vmcs.host.idtr_base, am.sidt().base);
    ...
}
```

セグメントレジスタのセレクタは以下のアセンブリ関数で取得します:

```ymir/arch/x86/asm.zig
const Segment = enum {
    cs,
    ss,
    ds,
    es,
    fs,
    gs,
    tr,
    ldtr,
};

pub fn readSegSelector(segment: Segment) u16 {
    return switch (segment) {
        .cs => asm volatile ("mov %%cs, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .ss => asm volatile ("mov %%ss, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .ds => asm volatile ("mov %%ds, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .es => asm volatile ("mov %%es, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .fs => asm volatile ("mov %%fs, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .gs => asm volatile ("mov %%gs, %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .tr => asm volatile ("str %[ret]"
            : [ret] "=r" (-> u16),
        ),
        .ldtr => asm volatile ("sldt %[ret]"
            : [ret] "=r" (-> u16),
        ),
    };
}
```

TR と LDTR 以外は全て MOV 命令で直接取得できます[^seg-sel]。
TR と LDTR はそれぞれ専用の命令である [STR](https://www.felixcloutier.com/x86/str) と [SLDT](https://www.felixcloutier.com/x86/sldt) を使用して取得します。

FS と GS の Base はハードウェア的に `IA32_FS_BASE` と `IA32_GS_BASE` という MSR にマップされています。
そのため、これらの Base は MSR から値を読むことで取得できます。
GDTR と IDTR の Base はそれぞれ [SGDT](https://www.felixcloutier.com/x86/sgdt) と [SIDT](https://www.felixcloutier.com/x86/sidt) 命令で取得できます。

SIDT および SGDT 取得の実装については、次の場所を参照してください:

<details>
<summary>SIDT and SGDT</summary>

```ymir/arch/x86/asm.zig
const SgdtRet = packed struct {
    limit: u16,
    base: u64,
};

pub inline fn sgdt() SgdtRet {
    var gdtr: SgdtRet = undefined;
    asm volatile (
        \\sgdt %[ret]
        : [ret] "=m" (gdtr),
    );
    return gdtr;
}

const SidtRet = packed struct {
    limit: u16,
    base: u64,
};

pub inline fn sidt() SidtRet {
    var idtr: SidtRet = undefined;
    asm volatile (
        \\sidt %[ret]
        : [ret] "=m" (idtr),
    );
    return idtr;
}
```

</details>

### MSR

一部の MSR は VM Exit の際にハードウェア的にセットすることができます。
この MSR は以下を含みます (全てではありません):

- `IA32_SYSENTER_CS` / `IA32_SYSENTER_ESP` / `IA32_SYSENTER_EIP`
- `IA32_EFER`
- `IA32_PAT`

本シリーズではシステムコールを実装しないため、`SYSENTER` 系のMSRは復元する必要がありません。
`IA32_PAT` はページのキャッシュ属性を定義することができる MSR ですがやはり本シリーズでは使いません。
`IA32_EFER` は 64bit モードの有効化等に必須の MSR であるため、この MSR だけ設定します:

```ymir/arch/x86/vmx/vcpu.zig
fn setupHostState(_: *Vcpu) VmxError!void {
    ...
    // MSR.
    try vmwrite(vmcs.host.efer, am.readMsr(.efer));
}
```

値は 0xC0000080 であることに注意してください。

## Guest-State

続いて Guest-State カテゴリを設定します。
このカテゴリは VM Entry した際のゲストの状態を制御します。

### Control Registers

Control Registers は VM Entry した際のゲストの CR0, CR3, CR4 の値を制御します。
本チャプターではこれらの値はホストと共有することにします:

```ymir/arch/x86/vmx/vcpu.zig
fn setupGuestState(_: *Vcpu) VmxError!void {
    // Control registers.
    try vmwrite(vmcs.guest.cr0, am.readCr0());
    try vmwrite(vmcs.guest.cr3, am.readCr3());
    try vmwrite(vmcs.guest.cr4, am.readCr4());
    ...
}
```

### セグメントレジスタ

ゲスト用のセグメントレジスタでは、セレクタ / Base / Limit / Access Rights をそれぞれ設定する必要があります。
かなりめんどくさいです。

まずは Base を設定します。
Base はどのセグメントでも利用しないため、適当に `0` を入れておきます。
LDTR だけは `0xDEAD00` を入れておきます。
これは実際に使うことはありませんが、**現在動いているのが VMM なのかゲストなのかを区別するためのマーカーとして使います**:

```ymir/arch/x86/vmx/vcpu.zig
    try vmwrite(vmcs.guest.cs_base, 0);
    try vmwrite(vmcs.guest.ss_base, 0);
    try vmwrite(vmcs.guest.ds_base, 0);
    try vmwrite(vmcs.guest.es_base, 0);
    try vmwrite(vmcs.guest.fs_base, 0);
    try vmwrite(vmcs.guest.gs_base, 0);
    try vmwrite(vmcs.guest.tr_base, 0);
    try vmwrite(vmcs.guest.gdtr_base, 0);
    try vmwrite(vmcs.guest.idtr_base, 0);
    try vmwrite(vmcs.guest.ldtr_base, 0xDEAD00); // Marker to indicate the guest.
```

Limit に関しても使わないので、とりあえずとり得る最大値を入れておきます:

```ymir/arch/x86/vmx/vcpu.zig
    try vmwrite(vmcs.guest.cs_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.ss_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.ds_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.es_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.fs_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.gs_limit, @as(u64, std.math.maxInt(u32)));
    try vmwrite(vmcs.guest.tr_limit, 0);
    try vmwrite(vmcs.guest.ldtr_limit, 0);
    try vmwrite(vmcs.guest.idtr_limit, 0);
    try vmwrite(vmcs.guest.gdtr_limit, 0);
```

続いてセレクタを設定します。
本チャプターで使うゲストである `blobGuest()` は関数のプロローグを持たないため、データセグメントは使いません。
利用するセグメントは CS だけです。
そのため、CS にだけホストと同じセレクタを入れておきます:

```ymir/arch/x86/vmx/vcpu.zig
    try vmwrite(vmcs.guest.cs_sel, am.readSegSelector(.cs));
    try vmwrite(vmcs.guest.ss_sel, 0);
    try vmwrite(vmcs.guest.ds_sel, 0);
    try vmwrite(vmcs.guest.es_sel, 0);
    try vmwrite(vmcs.guest.fs_sel, 0);
    try vmwrite(vmcs.guest.gs_sel, 0);
    try vmwrite(vmcs.guest.tr_sel, 0);
    try vmwrite(vmcs.guest.ldtr_sel, 0);
```

最後に Access Rights を設定します。
これは [GDTのチャプター](../kernel/gdt.md) で扱った GDT のエントリとほぼ同じ情報を持ちます。
しかしフォーマットが微妙に異なるので改めて VMCS 用に定義します。
各フィールドの意味については [GDTのチャプター](../kernel/gdt.md) のものと同じであるためそちらを参照してください:

```ymir/arch/x86/vmx/common.zig
pub const SegmentRights = packed struct(u32) {
    const gdt = @import("../gdt.zig");

    accessed: bool = true,
    rw: bool,
    dc: bool,
    executable: bool,
    desc_type: gdt.DescriptorType,
    dpl: u2,
    present: bool = true,
    _reserved1: u4 = 0,
    avl: bool = false,
    long: bool = false,
    db: u1,
    granularity: gdt.Granularity,
    unusable: bool = false,
    _reserved2: u15 = 0,
};
```

正直今回は CS だけ正しく設定できていればよいのですが、せっかくなので他のセグメントも一緒に設定してしまいます。


```ymir/arch/x86/vmx/vcpu.zig
    const cs_right = vmx.SegmentRights{
        .rw = true,
        .dc = false,
        .executable = true,
        .desc_type = .code_data,
        .dpl = 0,
        .granularity = .kbyte,
        .long = true,
        .db = 0,
    };
    const ds_right = vmx.SegmentRights{
        .rw = true,
        .dc = false,
        .executable = false,
        .desc_type = .code_data,
        .dpl = 0,
        .granularity = .kbyte,
        .long = false,
        .db = 1,
    };
    const tr_right = vmx.SegmentRights{
        .rw = true,
        .dc = false,
        .executable = true,
        .desc_type = .system,
        .dpl = 0,
        .granularity = .byte,
        .long = false,
        .db = 0,
    };
    const ldtr_right = vmx.SegmentRights{
        .accessed = false,
        .rw = true,
        .dc = false,
        .executable = false,
        .desc_type = .system,
        .dpl = 0,
        .granularity = .byte,
        .long = false,
        .db = 0,
    };
    try vmwrite(vmcs.guest.cs_rights, cs_right);
    try vmwrite(vmcs.guest.ss_rights, ds_right);
    try vmwrite(vmcs.guest.ds_rights, ds_right);
    try vmwrite(vmcs.guest.es_rights, ds_right);
    try vmwrite(vmcs.guest.fs_rights, ds_right);
    try vmwrite(vmcs.guest.gs_rights, ds_right);
    try vmwrite(vmcs.guest.tr_rights, tr_right);
    try vmwrite(vmcs.guest.ldtr_rights, ldtr_right);
```

CS と DS についてはホストに設定しているものと同じ値にしています。
TR と LDTR は Ymir では全く利用していませんが、これらを設定しないと VM Entry 時のチェックでエラーになってしまうため嫌々設定しています。
とはいってもこの2つに設定するべき値はほぼ固定値なので、そういうもんとして受け入れてください。

### RIP / RSP / MSR / RFLAGS など

今回のゲストである `blobGuest()` は RSP を使わないため RSP は設定する必要がありません。
RIP は `blobGuest()` のアドレスを指定しておきます。
RFLAGS も初期化する必要があります。
また、一部の MSR は VMCS のフィールドを使って設定することができます。
その中でも今回は `IA32_EFER` だけを設定します。
この MSR は 64bit モードを有効化するために必須です:

```ymir/arch/x86/vmx/vcpu.zig
    try vmwrite(vmcs.guest.rip, &blobGuest);
    try vmwrite(vmcs.guest.efer, am.readMsr(.efer));
    try vmwrite(vmcs.guest.rflags, am.FlagsRegister.new());
```

最後に、**VMCS Link Pointer** を設定します。
このフィールドは VMCS shadowing をする場合に利用されます。
利用しない場合には `0xFFFF_FFFF_FFFF_FFFF` を入れておく決まりがあるため、従います:

```ymir/arch/x86/vmx/vcpu.zig
    try vmwrite(vmcs.guest.vmcs_link_pointer, std.math.maxInt(u64));
```

## VM-Entry Control

このカテゴリは VM Entry におけるプロセッサの挙動を制御します[^entryctrl]。
設定する項目が少ない癒やし枠です:

```ymir/arch/x86/vmx/vmcs.zig
pub const EntryCtrl = packed struct(u32) {
    pub const Self = @This();

    _reserved1: u2,
    load_debug_controls: bool,
    _reserved2: u6,
    ia32e_mode_guest: bool,
    entry_smm: bool,
    deactivate_dualmonitor: bool,
    _reserved3: u1,
    load_perf_global_ctrl: bool,
    load_ia32_pat: bool,
    load_ia32_efer: bool,
    load_ia32_bndcfgs: bool,
    conceal_vmx_from_pt: bool,
    load_rtit_ctl: bool,
    load_uinv: bool,
    load_cet_state: bool,
    load_guest_lbr_ctl: bool,
    load_pkrs: bool,
    _reserved4: u9,

    pub fn load(self: Self) VmxError!void {
        const val: u32 = @bitCast(self);
        try vmx.vmwrite(ctrl.entry_ctrl, val);
    }

    pub fn store() VmxError!Self {
        const val: u32 = @truncate(try vmx.vmread(ctrl.entry_ctrl));
        return @bitCast(val);
    }
};
```

この内、*IA-32e Mode Guest* (`.ia32e_mode_guest`) を設定します。
このフィールドは VM Entry 後にゲストが IA-32e モードで動作することを示します。
これが有効になっている場合、VM Entry 後に `IA32_EFER.LMA` (Long Mode Activate) ビットがセットされ、64bit モードとして動作することができます:

```ymir/arch/x86/vmx/vcpu.zig
fn setupEntryCtrls(_: *Vcpu) VmxError!void {
    const basic_msr = am.readMsrVmxBasic();

    var entry_ctrl = try vmcs.EntryCtrl.store();
    entry_ctrl.ia32e_mode_guest = true;
    try adjustRegMandatoryBits(
        entry_ctrl,
        if (basic_msr.true_control) am.readMsr(.vmx_true_entry_ctls) else am.readMsr(.vmx_entry_ctls),
    ).load();
}
```

ここでも Reserved Bits は `IA32_VMX_ENTRY_CTRLS` または `IA32_VMX_TRUE_ENTRY_CTRLS` の値を参照して設定します。
値はそれぞれ0x0484と0x0490です。

## VM-Exit Control

このカテゴリは VM Exit におけるプロセッサの挙動を制御します[^exitctrl]。
一応 Primary と Secondary の2つがあります。
しかし、Secondary は設定項目が1つしかない上に本シリーズでは Primary しか使いません。
こいつも設定する項目が少ない癒やし枠その2です:

```ymir/arch/x86/vmx/vmcs.zig
pub const PrimaryExitCtrl = packed struct(u32) {
    const Self = @This();

    _reserved1: u2,
    save_debug: bool,
    _reserved2: u6,
    host_addr_space_size: bool,
    _reserved3: u2,
    load_perf_global_ctrl: bool,
    _reserved4: u2,
    ack_interrupt_onexit: bool,
    _reserved5: u2,
    save_ia32_pat: bool,
    load_ia32_pat: bool,
    save_ia32_efer: bool,
    load_ia32_efer: bool,
    save_vmx_preemption_timer: bool,
    clear_ia32_bndcfgs: bool,
    conceal_vmx_from_pt: bool,
    clear_ia32_rtit_ctl: bool,
    clear_ia32_lbr_ctl: bool,
    clear_uinv: bool,
    load_cet_state: bool,
    load_pkrs: bool,
    save_perf_global_ctl: bool,
    activate_secondary_controls: bool,

    pub fn load(self: Self) VmxError!void {
        const val: u32 = @bitCast(self);
        try vmx.vmwrite(ctrl.primary_exit_ctrl, val);
    }

    pub fn store() VmxError!Self {
        const val: u32 = @truncate(try vmx.vmread(ctrl.primary_exit_ctrl));
        return @bitCast(val);
    }
};
```

ここでは Host Address-Space Size (`.host_addr_space_size`) を設定します。
このフィールドは VM Exit 後にホストが 64bit モードで動作することを示します。
これが有効になっている場合、VM Exit 後に `IA32_EFER.LME` (Long Mode Enable) と `IA32_EFER.LMA` (Long Mode Activate) ビットがセットされ、64bit モードとして動作することができます:

```ymir/arch/x86/vmx/vcpu.zig
fn setupExitCtrls(_: *Vcpu) VmxError!void {
    const basic_msr = am.readMsrVmxBasic();

    var exit_ctrl = try vmcs.PrimaryExitCtrl.store();
    exit_ctrl.host_addr_space_size = true;
    exit_ctrl.load_ia32_efer = true;
    try adjustRegMandatoryBits(
        exit_ctrl,
        if (basic_msr.true_control) am.readMsr(.vmx_true_exit_ctls) else am.readMsr(.vmx_exit_ctls),
    ).load();
}
```

ここでも Reserved Bits は `IA32_VMX_EXIT_CTRLS` または `IA32_VMX_TRUE_EXIT_CTRLS` の値を参照して設定します。
値はそれぞれ0x0483と0x048Fです。

## VMLAUNCH

以上で VMCS の設定ができました。
最後に VMLAUNCH 命令を実行して VMX Non-root Operation に遷移します:

```ymir/arch/x86/vmx/vcpu.zig
pub fn loop(_: *Self) VmxError!void {
    const rflags = asm volatile (
        \\vmlaunch
        \\pushf
        \\popq %[rflags]
        : [rflags] "=r" (-> u64),
    );
    vmx.vmxtry(rflags) catch |err| {
        log.err("VMLAUNCH: {?}", .{err});
        log.err("VM-instruction error number: {s}", .{@tagName(try vmx.InstructionError.load())});
    };
}
```

この関数はまず最初に [VMLAUNCH](https://www.felixcloutier.com/x86/vmlaunch:vmresume) 命令を実行します。
VM Entry は2通りの失敗をする可能性があります:

- **VMLAUNCH 自体が失敗する**
  - 他の VMX 拡張命令が失敗した場合と同様に VMX Instruction Error を返します。
  - `loop()` 関数内の `VMLAUNCH` 命令の直後から実行が再開されます。
- **VMLAUNCH 自体は成功するが、すぐに VMEXIT する**
  - VMLAUNCH 自体が成功したが VM Entry に失敗するケースです。
  - VM Exit が発生し、VMCS Host-State に設定した RIP に実行が移ります。今回は `vmexitBootstrapHandler()` が呼ばれます。

`Vmx` に `Vcpu.loop()` を呼び出す関数を追加します。
のちのチャプターで扱いますが、Ymir は一度 VM を動かし始めると原則としてホスト側での割り込みを禁止するようにします:

```ymir/vmx.zig
pub fn loop(self: *Self) Error!void {
    arch.disableIntr();
    try self.vcpu.loop();
}
```

これを `kernelMain()` から呼び出します:

```ymir/main.zig
// Launch
log.info("Starting the virtual machine...", .{});
try vm.loop();
```

出力は以下のようになります:

```txt
[INFO ] main    | Entered VMX root operation.
[INFO ] main    | Starting the virtual machine...
```

無限 HLT ループで止まっているようです。
この状態で QEMU monitor でレジスタの状態を確認してみましょう:

```txt
[INFO ] main    | Starting the virtual machine...
QEMU 8.2.2 monitor - type 'help' for more information
(qemu) info registers

CPU#0
RAX=000000000000000a RBX=ffffffff8010c300 RCX=0000000000000000 RDX=00000000000003f8
RSI=0000000000000000 RDI=000000000000000a RBP=ffffffff80514018 RSP=0000000000000000
R8 =0000000000001000 R9 =0000000000000001 R10=0000000000000000 R11=00000000000001fe
R12=0000000080000000 R13=ffffffff8010c300 R14=0000000000001000 R15=0000000000009000
RIP=ffffffff8010a6b1 RFL=00000002 [-------] CPL=0 II=0 A20=1 SMM=0 HLT=1
ES =0000 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
CS =0010 0000000000000000 ffffffff 00a09b00 DPL=0 CS64 [-RA]
SS =0000 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
DS =0000 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
FS =0000 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
GS =0000 0000000000000000 ffffffff 00c09300 DPL=0 DS   [-WA]
LDT=0000 0000000000dead00 00000000 00008200 DPL=0 LDT
TR =0000 0000000000000000 00000000 00008b00 DPL=0 TSS64-busy
GDT=     0000000000000000 00000000
IDT=     0000000000000000 00000000
CR0=80010033 CR2=0000000000000000 CR3=0000000000001000 CR4=00002668
DR0=0000000000000000 DR1=0000000000000000 DR2=0000000000000000 DR3=0000000000000000
DR6=00000000ffff0ff0 DR7=0000000000000400
EFER=0000000000000d00
```

VMX Root Operation と VMX Non-root Operation のどちらの状態にいるのかを直接的に知る方法はありません。
注目するべきは LDT の Base です。
VMCS Guest-State でこの値はマーカーとして `0xDEAD00` に設定していました。
現在の LDT の Base が `0xDEAD00` であることから、**VMX Non-root Operation に遷移できていることがわかります**。

また、RIP の値 `0xFFFFFFFF8010A6B1` について `addr2line` でコードのどの部分に該当するかを確認してみます:

```sh
> addr2line -e ./zig-out/bin/ymir.elf 0xFFFFFFFF8010A6B1
/home/lysithea/ymir/ymir/arch/x86/vmx/vcpu.zig:390

> sed -n '390,392p' /home/lysithea/ymir/ymir/arch/x86/vmx/vcpu.zig
        asm volatile (
            \\hlt
        );
```

確かに HLT ループで止まっているということが確認できますね。
というわけで、無事に VMX Non-root Operation に遷移してゲストを実行することができました。

もう1つ実験として、Execution Control カテゴリの Primary Processor-Based Controls において、`.hlt` フィールドを `true` に設定してみましょう。
これによってゲストが HLT を実行すると VM Exit するようになります:

```diff
     var ppb_exec_ctrl = try vmcs.PrimaryProcExecCtrl.store();
-    ppb_exec_ctrl.hlt = false;
+    ppb_exec_ctrl.hlt = true;
     ppb_exec_ctrl.activate_secondary_controls = false;
```

実行すると以下の出力になります:

```txt
[INFO ] main    | Starting the virtual machine...
[DEBUG] vcpu    | [VMEXIT handler]
[DEBUG] vcpu    |    VMEXIT reason: arch.x86.vmx.vmcs.ExitInfo{ .basic_reason = arch.x86.vmcs.ExitReason.hlt, ._zero = 0, ._reserved1 = 0, ._one = 0, .pending_mtf = 0, .exit_vmxroot = false, ._reserved2 = 0, .entry_failure = false }
```

ゲストが HLT を実行すると VM Exit が発生し、Host-State に設定した RIP に処理が移ります。
RIP には `vmexitBootstrapHandler()` が設定されており、そこで VM Exit Reason を取得・表示しています。
今回の Reason は意図したとおり `hlt` であることが分かります。
これで VM Exit ハンドラが正しく呼ばれることも確認できました。

## まとめ

本チャプターでは VMCS の設定をして、VMX Non-root Operation に遷移しました。
ゲストとして HLT ループを行うだけの関数を実行し、IDTR に仕込んだマーカーから VM Entry が成功していることを確認しました。
また、VM Exit ハンドラを設定し、VM Exit Reason が取得できることも確認しました。

これでついにゲストを動かすことができました。
どんなに小さなゲストでも、仮想化されていることには変わりありません。
もはやこの状態の Ymir でも *"hypervisor"* を名乗ることができるのではないでしょうか。
無理か。

今のところゲストはホストのレジスタの状態をほぼ全て受け継いだ状態で動いています。
逆に、ホストも VM Exit 発生時のレジスタの状態をそのまま受け継いでいます。
次のチャプターでは VM Entry / VM Exit 時にレジスタを含むゲスト・ホストの状態を適切に保存する部分を実装していきます。

[^pbec]: *SDM Vol.3C 25.6.1 Pin-Based VM-Execution Controls*
[^pp]: *SDM Vol.3C 25.6.2 Processor-Based VM-Execution Controls*
[^seg-sel]: MOV 命令を使って直接セグメントレジスタにアクセスした場合、レジスタの Hidden Part はゼロクリアされて取得されます。
[^entryctrl]: *SDM Vol.3C 25.8.1 VM-Entry Control Fields*
[^exitctrl]: *SDM Vol.3C 25.7.1 VM-Exit Control Fields*
