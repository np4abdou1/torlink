# Arch Linux Installation for torlnk

### 1. Standalone Binary (Recommended)
Download the standalone x64 binary directly from [Releases](https://github.com/np4abdou1/torlink/releases):

```bash
curl -LO https://github.com/np4abdou1/torlink/releases/latest/download/torlnk
chmod +x torlnk
sudo mv torlnk /usr/local/bin/
```

### 2. Build Package with makepkg
```bash
git clone https://github.com/np4abdou1/torlink.git
cd torlink/packaging/arch
makepkg -si
```
