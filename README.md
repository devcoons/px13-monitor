# PX13 Monitor

A GNOME Shell top-bar indicator for fan speed, CPU temperature, GPU temperature, and memory use.

It is aimed at the ASUS ProArt PX13, and it discovers sensors from `/sys/class/hwmon` instead of hard-coding device numbers, so the same build works on other laptops.

On this PX13 it reads:

- CPU: `k10temp` Tctl
- GPU: `amdgpu` edge
- Fans: ASUS `cpu_fan` and `gpu_fan`
- Memory: `/proc/meminfo` (`MemTotal` and `MemAvailable`)

## Install

```sh
./install.sh
```

Appearance settings, under Extensions:

- Compact mode reads `CPU 44° 0500  GPU 42° 3000  RAM 22%`.
- Fixed-width fan speeds keep a set number of digits and dim the leading zeros. The digit count is its own setting.
