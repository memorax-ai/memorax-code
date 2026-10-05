// CI-only WFP proof. Windows SDK types avoid hand-marshaled filtering conditions.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <fwpmu.h>
#include <sddl.h>
#include <rpc.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>

namespace {
wchar_t kName[] = L"MemoraX Cursor loopback proof";
constexpr UINT16 kSubLayerWeight = 0xFFFF;
struct Failure { const char* step; const char* family; DWORD code; };
void Check(DWORD code, const char* step, const char* family = "none") {
    if (code != ERROR_SUCCESS) throw Failure{step, family, code};
}
void Require(bool condition, const char* step, const char* family = "none") {
    if (!condition) throw Failure{step, family, ERROR_INVALID_DATA};
}
GUID ParseGuid(const wchar_t* text) {
    GUID value{};
    Require(text && wcslen(text) == 36, "input");
    Check(UuidFromStringW(reinterpret_cast<RPC_WSTR>(const_cast<wchar_t*>(text)), &value), "input");
    Require(value != GUID{}, "input");
    return value;
}
UINT16 ParsePort(const wchar_t* text) {
    Require(text && *text && wcslen(text) <= 5, "input");
    unsigned value = 0;
    for (const wchar_t* next = text; *next; ++next) {
        Require(*next >= L'0' && *next <= L'9', "input");
        value = value * 10 + static_cast<unsigned>(*next - L'0');
    }
    Require(value > 0 && value <= 65535, "input");
    return static_cast<UINT16>(value);
}
struct Plan {
    GUID subLayer;
    std::array<GUID, 6> keys;
    std::array<UINT16, 2> ports;
    PSECURITY_DESCRIPTOR security = nullptr;
    FWP_BYTE_BLOB sid{};
    FWP_BYTE_ARRAY16 address6{};
    UINT64 allowWeight = 0xFFFFFFFFFFFFFFFFull;
    UINT64 blockWeight = 0xFFFFFFFFFFFFFFFEull;
    Plan(const wchar_t* user, const wchar_t* layer, const wchar_t* allow4, const wchar_t* allow6,
         const wchar_t* block4, const wchar_t* block6, const wchar_t* udp4, const wchar_t* udp6,
         const wchar_t* port4, const wchar_t* port6)
        : subLayer(ParseGuid(layer)), keys{ParseGuid(allow4), ParseGuid(allow6), ParseGuid(block4), ParseGuid(block6),
              ParseGuid(udp4), ParseGuid(udp6)},
          ports{ParsePort(port4), ParsePort(port6)} {
        for (size_t index = 0; index < keys.size(); ++index) {
            Require(subLayer != keys[index], "input");
            for (size_t previous = 0; previous < index; ++previous)
                Require(keys[previous] != keys[index], "input");
        }
        Require(user && wcslen(user) <= 184 && wcsncmp(user, L"S-1-5-21-", 9) == 0, "input");
        for (const wchar_t* next = user + 9; *next; ++next)
            Require((*next >= L'0' && *next <= L'9') || *next == L'-', "input");
        const std::wstring descriptor = L"D:(A;;CC;;;" + std::wstring(user) + L")";
        ULONG securitySize = 0;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(), SDDL_REVISION_1,
                &security, &securitySize)) Check(GetLastError(), "input");
        sid.size = securitySize;
        sid.data = static_cast<UINT8*>(security);
        address6.byteArray16[15] = 1;
    }
    Plan(const Plan&) = delete;
    Plan& operator=(const Plan&) = delete;
    ~Plan() { if (security) LocalFree(security); }
};
void BuildFilter(Plan& plan, size_t index, FWPM_FILTER0& filter,
                 std::array<FWPM_FILTER_CONDITION0, 4>& conditions) {
    Require(index < plan.keys.size(), "filter-plan");
    const bool allow = index < 2;
    const bool udpBinding = index >= 4;
    const size_t family = index % 2;
    filter = {}; conditions = {};
    filter.filterKey = plan.keys[index];
    filter.displayData.name = kName;
    filter.flags = 0;
    filter.layerKey = udpBinding
        ? (family == 0 ? FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4 : FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6)
        : (family == 0 ? FWPM_LAYER_ALE_AUTH_CONNECT_V4 : FWPM_LAYER_ALE_AUTH_CONNECT_V6);
    filter.subLayerKey = plan.subLayer;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = allow ? &plan.allowWeight : &plan.blockWeight;
    filter.numFilterConditions = allow ? 4 : udpBinding ? 2 : 1;
    filter.filterCondition = conditions.data();
    // The exact soft permit wins only inside this owned sublayer; other providers may still block it.
    filter.action.type = allow ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    for (auto& condition : conditions) condition.matchType = FWP_MATCH_EQUAL;
    conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
    conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
    conditions[0].conditionValue.sd = &plan.sid;
    if (!allow && !udpBinding) return;
    conditions[1].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
    conditions[1].conditionValue.type = FWP_UINT8;
    conditions[1].conditionValue.uint8 = static_cast<UINT8>(udpBinding ? 17 : 6);
    if (udpBinding) return;
    conditions[2].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
    conditions[2].conditionValue.type = family == 0 ? FWP_UINT32 : FWP_BYTE_ARRAY16_TYPE;
    if (family == 0) conditions[2].conditionValue.uint32 = 0x7F000001;
    else conditions[2].conditionValue.byteArray16 = &plan.address6;
    conditions[3].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
    conditions[3].conditionValue.type = FWP_UINT16;
    conditions[3].conditionValue.uint16 = plan.ports[family];
}
bool OwnedFilter(const FWPM_FILTER0& filter, const Plan& plan, size_t index) {
    if (index >= plan.keys.size()) return false;
    const bool allow = index < 2;
    const bool udpBinding = index >= 4;
    const size_t family = index % 2;
    const FWP_ACTION_TYPE expectedAction = allow ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    const GUID& expectedLayer = udpBinding
        ? (family == 0 ? FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4 : FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6)
        : (family == 0 ? FWPM_LAYER_ALE_AUTH_CONNECT_V4 : FWPM_LAYER_ALE_AUTH_CONNECT_V6);
    if (filter.filterKey != plan.keys[index] || filter.subLayerKey != plan.subLayer ||
        filter.layerKey != expectedLayer ||
        filter.flags != 0 || filter.providerKey || filter.providerData.size != 0 || filter.rawContext != 0 ||
        !filter.displayData.name || wcscmp(filter.displayData.name, kName) != 0 ||
        filter.action.type != expectedAction || filter.weight.type != FWP_UINT64 ||
        !filter.weight.uint64 || *filter.weight.uint64 != (allow ? plan.allowWeight : plan.blockWeight) ||
        filter.numFilterConditions != (allow ? 4u : udpBinding ? 2u : 1u) || !filter.filterCondition) return false;
    unsigned seen = 0;
    for (UINT32 i = 0; i < filter.numFilterConditions; ++i) {
        const auto& condition = filter.filterCondition[i];
        const auto& value = condition.conditionValue;
        if (condition.matchType != FWP_MATCH_EQUAL) return false;
        unsigned bit = 0;
        if (condition.fieldKey == FWPM_CONDITION_ALE_USER_ID) {
            bit = 1;
            if (value.type != FWP_SECURITY_DESCRIPTOR_TYPE || !value.sd || !value.sd->data ||
                value.sd->size != plan.sid.size || memcmp(value.sd->data, plan.sid.data, plan.sid.size) != 0) return false;
        } else if ((allow || udpBinding) && condition.fieldKey == FWPM_CONDITION_IP_PROTOCOL) {
            bit = 2;
            if (value.type != FWP_UINT8 || value.uint8 != (udpBinding ? 17 : 6)) return false;
        } else if (allow && condition.fieldKey == FWPM_CONDITION_IP_REMOTE_ADDRESS) {
            bit = 4;
            if (family == 0) {
                if (value.type != FWP_UINT32 || value.uint32 != 0x7F000001) return false;
            } else if (value.type != FWP_BYTE_ARRAY16_TYPE || !value.byteArray16 ||
                       memcmp(value.byteArray16, &plan.address6, sizeof(plan.address6)) != 0) return false;
        } else if (allow && condition.fieldKey == FWPM_CONDITION_IP_REMOTE_PORT) {
            bit = 8;
            if (value.type != FWP_UINT16 || value.uint16 != plan.ports[family]) return false;
        }
        if (bit == 0 || (seen & bit)) return false;
        seen |= bit;
    }
    return seen == (allow ? 15u : udpBinding ? 3u : 1u);
}
FWPM_SUBLAYER0 BuildSubLayer(const Plan& plan) {
    FWPM_SUBLAYER0 layer{};
    layer.subLayerKey = plan.subLayer;
    layer.displayData.name = kName;
    layer.weight = kSubLayerWeight;
    return layer;
}
bool OwnedSubLayer(const FWPM_SUBLAYER0& layer, const Plan& plan) {
    return layer.subLayerKey == plan.subLayer && layer.flags == 0 && !layer.providerKey &&
        layer.providerData.size == 0 && layer.weight == kSubLayerWeight &&
        layer.displayData.name && wcscmp(layer.displayData.name, kName) == 0;
}
struct Engine {
    HANDLE handle = nullptr;
    bool transaction = false;
    Engine() {
        FWPM_SESSION0 session{};
        // Static, nonpersistent objects survive this controller's exit until explicit cleanup or VM teardown.
        session.flags = 0;
        Check(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &handle), "engine-open");
    }
    ~Engine() {
        if (transaction) FwpmTransactionAbort0(handle);
        if (handle) FwpmEngineClose0(handle);
    }
    void Begin() { Check(FwpmTransactionBegin0(handle, 0), "transaction-begin"); transaction = true; }
    void Commit() { Check(FwpmTransactionCommit0(handle), "transaction-commit"); transaction = false; }
    void Close() { Check(FwpmEngineClose0(handle), "engine-close"); handle = nullptr; }
};
struct WfpMemory {
    void* pointer = nullptr;
    ~WfpMemory() { if (pointer) FwpmFreeMemory0(&pointer); }
};
// All-present or all-absent are the only accepted states; partial/foreign state is retained.
bool VerifyPolicy(Engine& engine, const Plan& plan, bool allowAbsent) {
    unsigned present = 0;
    WfpMemory layerMemory;
    DWORD code = FwpmSubLayerGetByKey0(engine.handle, &plan.subLayer,
        reinterpret_cast<FWPM_SUBLAYER0**>(&layerMemory.pointer));
    if (code != static_cast<DWORD>(FWP_E_SUBLAYER_NOT_FOUND)) {
        Check(code, "verify-sublayer");
        Require(layerMemory.pointer && OwnedSubLayer(*static_cast<FWPM_SUBLAYER0*>(layerMemory.pointer), plan), "verify-sublayer");
        ++present;
    }
    for (size_t index = 0; index < plan.keys.size(); ++index) {
        const char* family = index % 2 == 0 ? "ipv4" : "ipv6";
        WfpMemory memory;
        code = FwpmFilterGetByKey0(engine.handle, &plan.keys[index], reinterpret_cast<FWPM_FILTER0**>(&memory.pointer));
        if (code == static_cast<DWORD>(FWP_E_FILTER_NOT_FOUND)) continue;
        Check(code, "verify-filter", family);
        Require(memory.pointer && OwnedFilter(*static_cast<FWPM_FILTER0*>(memory.pointer), plan, index), "verify-filter", family);
        ++present;
    }
    Require(present == 7 || (allowAbsent && present == 0), "verify-policy");
    return present == 7;
}
void Run(const std::wstring& action, Plan& plan) {
    Engine engine;
    if (action == L"install") {
        engine.Begin();
        Require(!VerifyPolicy(engine, plan, true), "precheck");
        auto layer = BuildSubLayer(plan);
        Check(FwpmSubLayerAdd0(engine.handle, &layer, nullptr), "sublayer-add");
        for (size_t index = 0; index < plan.keys.size(); ++index) {
            FWPM_FILTER0 filter{};
            std::array<FWPM_FILTER_CONDITION0, 4> conditions{};
            BuildFilter(plan, index, filter, conditions);
            Require(OwnedFilter(filter, plan, index), "filter-plan", index % 2 == 0 ? "ipv4" : "ipv6");
            Check(FwpmFilterAdd0(engine.handle, &filter, nullptr, nullptr), "filter-add", index % 2 == 0 ? "ipv4" : "ipv6");
        }
        engine.Commit();
        VerifyPolicy(engine, plan, false);
    } else if (action == L"verify") {
        VerifyPolicy(engine, plan, false);
    } else {
        engine.Begin();
        if (VerifyPolicy(engine, plan, true)) {
            for (size_t index = 0; index < plan.keys.size(); ++index)
                Check(FwpmFilterDeleteByKey0(engine.handle, &plan.keys[index]), "filter-delete", index % 2 == 0 ? "ipv4" : "ipv6");
            Check(FwpmSubLayerDeleteByKey0(engine.handle, &plan.subLayer), "sublayer-delete");
        }
        engine.Commit();
        Require(!VerifyPolicy(engine, plan, true), "verify-removed");
    }
    engine.Close();
}
int PrintFailure(const Failure& error) {
    std::printf("{\"status\":\"FAIL\",\"step\":\"%s\",\"family\":\"%s\",\"nativeErrorCode\":%lu}\n",
        error.step, error.family, static_cast<unsigned long>(error.code));
    return 1;
}
} // namespace

#ifndef CURSOR_WFP_UNIT_TEST
int wmain(int argc, wchar_t** argv) {
    try {
        Require(argc == 12 && (wcscmp(argv[1], L"install") == 0 || wcscmp(argv[1], L"verify") == 0 ||
            wcscmp(argv[1], L"remove") == 0), "input");
        Plan plan(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8], argv[9], argv[10], argv[11]);
        Run(argv[1], plan);
        std::puts("{\"status\":\"PASS\",\"filterCount\":6}");
        return 0;
    } catch (const Failure& error) { return PrintFailure(error); }
    catch (...) { return PrintFailure({"unexpected", "none", ERROR_INVALID_DATA}); }
}
#endif
