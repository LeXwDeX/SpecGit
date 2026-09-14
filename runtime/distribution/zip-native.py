"""Package a tested executable with deterministic metadata, or verify its ZIP."""
import pathlib
import stat
import sys
import zipfile

mode, archive, binary, name = sys.argv[1:]
if name not in ('specgit', 'specgit.exe'):
    raise ValueError('Unexpected installed filename')
expected = pathlib.Path(binary).read_bytes()
if mode == 'create':
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.create_system = 3
    entry.external_attr = (stat.S_IFREG | 0o755) << 16
    entry.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        package.writestr(entry, expected, compresslevel=9)
elif mode != 'verify':
    raise ValueError('Choose create or verify')
with zipfile.ZipFile(archive) as package:
    if package.namelist() != [name]:
        raise ValueError('ZIP inventory differs')
    entry = package.getinfo(name)
    if entry.file_size != len(expected) or not stat.S_ISREG(entry.external_attr >> 16):
        raise ValueError('ZIP executable size or type differs')
    if package.testzip() is not None:
        raise ValueError('ZIP CRC differs')
    if package.read(name) != expected:
        raise ValueError('ZIP executable differs from tested bytes')
