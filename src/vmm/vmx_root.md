# VT-x の基礎と VMX Root Operation

長かった Ymir Kernel の実装も一段落し、いよいよ VMM 部分の実装に入っていきます。
本チャプターは VT-x の基礎的な概念の説明から始まり、VMX Root Operation という VMM 用のモードに遷移するところまでを目的にします。

## Table of Contents

<!-- toc -->

## VMM 概観

まずは hypervisor における基礎的な概念や用語を確認します。
以降は、Ymir のようにベアメタルで動作し CPU や外部リソースに対する完全な制御権を持つソフトを **VMM: Virtual-Machine Monitor** (hypervisor) と呼びます。
VMM の上で動作し、CPU 上で直接動作するものの VMM によってリソースへのアクセス権が仮想化されるソフトを **ゲスト** と呼びます。

仮想化を支援する CPU では、**VMX Operation** というモードに入ることができます。
このモードでは仮想化を支援する命令が追加されたり、CPU の挙動が変更されたりします。
VMX Operation には **VMX Root Operation** と **VMX Non-root Operation** の2つのモードがあります。
VMM は VMX Root Operation で動作します。
このモードは VMX Operation ではない場合とほぼ同じですが、新たに VMX に関連する命令が追加されています。
ゲストは VMX Non-root Operation で動作します。
このモードでは一部の特権命令が制限され、それらの命令を実行すると処理が VMM に移されます。
このような、VMX Non-root から VMX Root へのモード遷移を **VM Exit** と呼び、
逆に VMX Root から VMX Non-root へのモード遷移を **VM Entry** と呼びます。
特権命令が VM Exit を引き起こすことで、VMM はゲストの挙動に介入し、リソースを仮想化できます。

![Interaction of a Virtual-Machine Monitor and Guests](../assets/sdm/interaction_vmm.png)
*Interaction of a Virtual-Machine Monitor and Guests. SDM Vol.3C 24.4 Figure 24-1.*

Ymir Kernel は [VMXON](https://www.felixcloutier.com/x86/vmxon) 命令によって VMX Root Operation に遷移します。
逆に VMX Root Operation から通常のモードに遷移する際には [VMXOFF](https://www.felixcloutier.com/x86/vmxoff) 命令を使用します。
VMX Operation に遷移した CPU は新たに拡張命令を利用できるようになります。
その1つである [VMLAUNCH](https://www.felixcloutier.com/x86/vmlaunch:vmresume) や [VMRESUME](https://www.felixcloutier.com/x86/vmlaunch:vmresume) 命令を使用して VM Entry を行います。
ゲスト(VMX Non-Root Operation) に遷移したあとは、基本的には通常通り CPU 上で直接ゲストの命令が実行できます。
ソフトウェアによる命令のエミュレーションが必要ないため、VT-x によるハードウェアレベルでの仮想化はソフトウェア仮想化よりも高速になります。
ゲストが特権命令を実行したり特定の条件を満たした場合[^condition]には VM Exit が発生し、Root Operation への遷移が発生します。
VMM は VM Exit の発生原因をもとにして適切な処理を行い、再度 VM Entry でゲストに制御を戻します。

なお、VMX Operation は Ring とは別の概念です。
ゲストが Ring-0 で動作している場合でも VMX Non-root Operation で動作している限りは VMM による支配を受けることになります。

## VMX サポートの確認

まずは CPU が VT-x をサポートしているかどうかを確認する必要があります。
これには以下の段階を踏みます:

1. [CPUID](https://www.felixcloutier.com/x86/cpuid) 命令で Vendor ID を確認する
    - 同じ x64 アーキテクチャでもベンダが異なれば提供する仮想化支援機構が異なる
    - Vendor ID が `GenuineIntel` であることを確認する[^genuine]
2. [CPUID](https://www.felixcloutier.com/x86/cpuid) 命令で VMX がサポートされているかを確認する
3. [CPUID](https://www.felixcloutier.com/x86/cpuid) 命令で [SMX Operation](https://www.intel.co.jp/content/www/jp/ja/content-details/315168/intel-trusted-execution-technology-intel-txt-software-development-guide.html) でなくとも VMXON できることを確認する
    - SMX: Safer Mode Extension は、Intel® Trusted Execution Technology で提供されるモード。Ymir では使わないため SMX の外でも VMXON できる必要がある

VMX Operation に入る前にこれらの条件が満たされているかを順に確認していきます。
以降、VMX に関連する操作は `ymir/vmx.zig` をルートとして実装していきます:

```ymir/vmx.zig
const VmError = error{
    /// Memory allocation failed.
    OutOfMemory,
    /// The system does not support virtualization.
    SystemNotSupported,
    /// Unknown error.
    UnknownError,
};

pub const Vm = struct {
    const Self = @This();

    pub fn new() VmError!Self {
        // 1. Check CPU vendor.
        TODO
        // 2&3. Check if VMX is supported.
        TODO

        return Self{};
    }
};
```

### CPUID

VMX 関連の操作に入る前に、まずは [CPUID](https://www.felixcloutier.com/x86/cpuid) をする関数を実装します。
CPUID はプロセッサの機能を取得するための命令であり、ベンダや世代やモデルに固有な情報を得るために使用します。

EAX 取得したい情報を指定します。一部の場合は追加で ECX も使って取得する情報を指定します。
このとき、EAX のことを **Leaf**, ECX のことを **Subleaf** と呼びます。
本シリーズでは、Leaf が `N` で Subleaf が `M` の CPUID を `CPUID[N:M]` と表記します。
返り値には EAX, EBX, ECX, EDX の4つのレジスタが使われます。
どれに何が入るかは Leaf/Subleaf に依存します。
CPUID の Leaf/Subleaf 一覧については *SDM Vol.2A Chapter 3.3 Table 3-8* を参照してください。

```ymir/arch/x86/cpuid.zig
pub const Leaf = enum(u32) {
    maximum_input = 0x0,
    version_info = 0x1,
    ext_feature = 0x7,
    ext_enumeration = 0xD,
    ext_func = 0x80000000,
    ext_proc_signature = 0x80000001,
    _,

    /// Convert u64 to Leaf.
    pub fn from(rax: u64) Leaf {
        return @enumFromInt(rax);
    }
    /// Issues CPUID instruction to query the leaf and sub-leaf.
    pub fn query(self: Leaf, subleaf: ?u32) CpuidRegisters {
        return cpuid(@intFromEnum(self), subleaf orelse 0);
    }
};

const CpuidRegisters = struct {
    eax: u32,
    ebx: u32,
    ecx: u32,
    edx: u32,
};
```

`Leaf` すべての Leaf を列挙しているわけではありません。
というか、CPUID は無限に拡張されていくためすべてを列挙するのは不可能ですし意味がありません。
ここでは使う分だけを列挙し、残りは `_` として無視しています。
このような `_` を持つ `enum` は [Non-exhaustive Enum](https://ziglang.org/documentation/master/#Non-exhaustive-enum) と呼びます。
Non-exhaustive Enum への `switch` は必ず non-exhaustive switch になります。

`Leaf` は以下のように使います:

```zig
const result = Leaf.query(.ext_feature, 0x1);
// OR
const result = Leaf.ext_feature.query(0x1);
```

もしも Subleaf を指定する必要があれば `query()` の引数として渡します。
Subleaf が不要な場合は `null` を渡すことができます。

> [!TIP] Zig のメソッド
> Zig における static ではない構造体のメソッドは、`fn hoge(self: Self)` のように定義します。
> これを呼び出す際には、以下の2通りの方法があります:
>
> ```zig
> const result = some_struct.hoge();
> const result = SomeStruct.hoge(some_struct);
> ```
>
> 前者は単なる後者のシンタックスシュガーです。
> C++ の `this` と同じですね。

`cpuid()` は CPUID 命令の実体となるアセンブリ関数です。
この関数は外部には直接露出せず、`Leaf` を介して利用させます:

```ymir/arch/x86/cpuid.zig
fn cpuid(leaf: u32, subleaf: u32) CpuidRegisters {
    var eax: u32 = undefined;
    var ebx: u32 = undefined;
    var ecx: u32 = undefined;
    var edx: u32 = undefined;

    asm volatile (
        \\mov %[leaf], %%eax
        \\mov %[subleaf], %%ecx
        \\cpuid
        \\mov %%eax, %[eax]
        \\mov %%ebx, %[ebx]
        \\mov %%ecx, %[ecx]
        \\mov %%edx, %[edx]
        : [eax] "=r" (eax),
          [ebx] "=r" (ebx),
          [ecx] "=r" (ecx),
          [edx] "=r" (edx),
        : [leaf] "r" (leaf),
          [subleaf] "r" (subleaf),
        : "rax", "rbx", "rcx", "rdx"
    );

    return .{
        .eax = eax,
        .ebx = ebx,
        .ecx = ecx,
        .edx = edx,
    };
}
```

### MSR

CPUID と同様にアーキテクチャの機能を取得および操作するために使用するのが **MSR: Model Specific Register** です。
MSR は通常のレジスタとは異なり、アクセスには特権が必要となります[^msr]。
MSR も CPUID と同様にどんどん追加され続けるため、すべてを列挙することはしません。
必要なものだけを列挙して定義します。
以下で定義しているものは Ymir で利用する MSR の全てではありません。
必要になった時に新たに追加していきます:

```ymir/arch/x86/asm.zig
pub const Msr = enum(u32) {
    /// IA32_VMX_BASIC MSR.
    vmx_basic = 0x0480,

    _,
};
```

MSR へのアクセスには [RDMSR](https://www.felixcloutier.com/x86/rdmsr) と [WRMSR](https://www.felixcloutier.com/x86/wrmsr) 命令を使います。
MSR の指定には ECX を使います。
返り値は EDX と EAX をこの順に連結した値となります:

```ymir/arch/x86/asm.zig
pub fn readMsr(msr: Msr) u64 {
    var eax: u32 = undefined;
    var edx: u32 = undefined;
    asm volatile (
        \\rdmsr
        : [eax] "={eax}" (eax),
          [edx] "={edx}" (edx),
        : [msr] "{ecx}" (@intFromEnum(msr)),
    );

    return bits.concat(u64, edx, eax);
}

pub fn writeMsr(msr: Msr, value: u64) void {
    asm volatile (
        \\wrmsr
        :
        : [msr] "{ecx}" (@intFromEnum(msr)),
          [eax] "{eax}" (@as(u32, @truncate(value))),
          [edx] "{edx}" (@as(u32, @truncate(value >> 32))),
    );
}
```

### Vendor ID の確認

手順1の Vendor ID String は `CPUID[0]` で取得できます:

```ymir/arch/x86/arch.zig
pub fn getCpuVendorId() [12]u8 {
    var ret: [12]u8 = undefined;
    const regs = cpuid.Leaf.query(.maximum_input, null);

    for ([_]u32{ regs.ebx, regs.edx, regs.ecx }, 0..) |reg, i| {
        for (0..4) |j| {
            const b: usize = (reg >> @truncate(j * 8));
            ret[i * 4 + j] = @as(u8, @truncate(b));
        }
    }
    return ret;
}
```

`Vm.new()` で Vendor ID を取得し、`GenuineIntel` であることを確認します:

```ymir/vmx.zig
const vendor = arch.getCpuVendorId();
if (!std.mem.eql(u8, vendor[0..], "GenuineIntel")) {
    log.err("Unsupported CPU vendor: {s}", .{vendor});
    return Error.SystemNotSupported;
}
```

### VMX サポートを確認

手順 2/3 は同じ関数内 `isVmxSupported()` で確認します。
まず手順2の VMX がサポートされているかどうかは `CPUID[7]` で確認します。
手順3では VMXON が SMX Operation の外でも実行可能かを確認します。
これは MSR の `IA32_FEATURE_CONTROL` の値をチェックすることで確かめられます:

```ymir/arch/x86/arch.zig
pub fn isVmxSupported() bool {
    // Check CPUID if VMX is supported.
    const regs = cpuid.Leaf.query(.ext_feature, null);
    const ecx: cpuid.FeatureInfoEcx = @bitCast(regs.ecx);
    if (!ecx.vmx) return false;

    // Check VMXON is allowed outside SMX.
    var msr_fctl: am.MsrFeatureControl = @bitCast(am.readMsr(.feature_control));
    if (!msr_fctl.vmx_outside_smx) {
        // Enable VMX outside SMX.
        if (msr_fctl.lock) @panic("IA32_FEATURE_CONTROL is locked while VMX outside SMX is disabled");
        msr_fctl.vmx_outside_smx = true;
        msr_fctl.lock = true;
        am.writeMsr(.feature_control, @bitCast(msr_fctl));
    }
    msr_fctl = @bitCast(am.readMsr(.feature_control));
    if (!msr_fctl.vmx_outside_smx) return false;

    return true;
}
```

VMXON Outside SMX が無効化されていた場合、MSR を操作して有効化します。
このとき、`IA32_FEATURE_CONTROL[0]` の **Lock Bit** がクリアされていることを確認します。
Lock Bit がセットされている場合、この MSR には一切の書き込みができません。
Lock Bit はシステムがリセットされるまでクリアされることがないため、もしもこのビットがセットされている場合には諦めるしかありません。
逆に、Lock Bit がクリアされていると VMXON が失敗するため、この関数内でロックしておきます。

そもそも Lock Bit は BIOS がシステムでサポートする機能を設定・固定化するためのものです。
一度 BIOS から設定されたあとは OS 側で変更できない場合がほとんどです。
もしも VMX Outside SMX が無効化されていた場合には、お使いのホストBIOSの設定を見直してみてください。

`Vm.new()` の中でこれらの関数を呼び出します:

```ymir/vmx.zig
if (!arch.isVmxSupported()) {
    log.err("Virtualization is not supported.", .{});
    return Error.SystemNotSupported;
}
```

以上で VMX がサポートされているかどうかを確認する処理が完成しました。
`kernelMain()` から呼び出して、VMX がサポートされていることを確認しましょう:

```ymir/main.zig
var vm = try vmx.Vm.new();
_ = vm;
```

## vCPU

VMX Operation に入るというのは現在の CPU の状態を変更することであり、各CPUに対して行う操作です。
本シリーズの Ymir では1コアのみをサポートするためとりわけ意識する必要があることではないのですが、
それでも CPU に固有ということを意識するためにも `Vcpu` という構造体を作っておきます:

```ymir/arch/x86/vmx/vcpu.zig
pub const Vcpu = struct {
    const Self = @This();

    /// ID of the logical processor.
    id: usize = 0,
    /// VPID of the virtual machine.
    vpid: u16,

    pub fn new(vpid: u16) Self {
        return Self{ .vpid = vpid };
    }
};
```

**VPID: Virtual-Processor Identifier** は vCPU に対するユニークなID(16bit)です。
PCID のように、TLB のエントリを識別する等に使われます。
`id` は論理コアのIDです[^core]。
本シリーズの Ymir は1コアのみをサポートするため `id` は `0` で固定していますが、SMP をサポートするようにする場合にはこの値をコアごとに変更します。

`Vm` 構造体には `Vcpu` をもたせておきましょう。
ここでも、CPU に強く依存する VMX コードは `arch/x86/vmx` 以下に配置することにします。
もしも AMD-V をサポートしたくなったような場合には `switch` で分岐することができます:

```ymir/vmx.zig
const impl = switch (builtin.target.cpu.arch) {
    .x86_64 => @import("arch/x86/vmx.zig"),
    else => @compileError("Unsupported architecture."),
};

pub const Vm = struct {
    vcpu: impl.Vcpu,

    pub fn new() VmError!Self {
        ...
        return Self{ .vcpu = vcpu };
    }
};
```

## VMX Operation への遷移

VMX がサポートされていることが確認できたため、VMX Operation へ遷移しましょう。

TODO

[^condition]: VM Exit が発生する要因についてはのちのチャプターで詳しく扱います。
例として、例外の発生・特定のメモリへのアクセス・あらかじめ VMM が設定した時間の経過等があります。
[^genuine]: ごくごく僅かな個体は `GenuineIotel` という Vendor ID を返すことが[あるらしい](https://x.com/InstLatX64/status/1101230794364862464)です。
製造ミスでしょうか？
[^msr]: Ring-0 以外でアクセスした場合には `#GP(0)` が発生します。
[^core]: 本シリーズでは仮想コアを **vCPU**、通常のCPUコアを **論理コア** または単純にCPUコアと呼びます。
