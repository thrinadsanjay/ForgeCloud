# Additional data disk mount points + LVM

**Date:** 2026-07-24  
**Status:** Approved

## Behavior

- When **Additional disk** is enabled, the provision form shows disk size plus an optional mount-point table (path + size GB) with **+** to add rows.
- Validation: sum of mount sizes ≤ `additionalDiskGB − 1` (at least **1 GB** free left in the VG).
- Empty mount list is **allowed** → disk is attached and left raw (no VG/LV/mounts).
- Paths must be absolute and unique; sizes integers ≥ 1.

## Payload

```json
{
  "additionalDiskGB": 50,
  "diskMounts": [
    { "path": "/data", "sizeGB": 20 },
    { "path": "/data/logs", "sizeGB": 10 }
  ]
}
```

## Ansible `initial_setup`

When `data_mounts` is non-empty and an unused data disk exists:

1. Create PV on the unused disk → VG **`vg_data`**
2. For each mount, LV name = `lv_` + path with `/` → `_` (e.g. `/data/logs` → `lv_data_logs`)
3. Filesystem: **xfs** if `mkfs.xfs` available, else **ext4**
4. Mount + fstab

When `data_mounts` is empty: attach-only; Ansible skips LVM.
