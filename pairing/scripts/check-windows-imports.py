"""Diagnose Windows loader failures without launching the GUI or changing the OS."""
import ctypes, pathlib, struct, sys
exe=pathlib.Path(sys.argv[1]); data=exe.read_bytes()
u16=lambda offset: struct.unpack_from('<H',data,offset)[0]
u32=lambda offset: struct.unpack_from('<I',data,offset)[0]
pe=u32(0x3c); sections=u16(pe+6); optional=pe+24
assert u16(optional)==0x20b, 'Expected PE32+'
section_table=optional+u16(pe+20)
def offset(rva):
    for index in range(sections):
        section=section_table+40*index; size,address,raw_size,raw=struct.unpack_from('<IIII',data,section+8)
        if address <= rva < address+max(size,raw_size):return raw+rva-address
    raise ValueError(f'Unmapped RVA {rva:x}')
def string(at):return data[at:data.index(b'\0',at)].decode('ascii')
imports=u32(optional+112+8); descriptor=offset(imports); missing=[]
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.GetProcAddress.argtypes=[ctypes.c_void_p,ctypes.c_void_p];kernel.GetProcAddress.restype=ctypes.c_void_p
while True:
    original,_,_,name,first=struct.unpack_from('<IIIII',data,descriptor)
    if not name:break
    library=string(offset(name)); print('DLL',library,flush=True)
    try: dll=ctypes.WinDLL(library)
    except OSError as error:missing.append(f'{library}: {error}');descriptor+=20;continue
    thunk=offset(original or first)
    while True:
        value=struct.unpack_from('<Q',data,thunk)[0]
        if not value:break
        if value & (1<<63):symbol=value&0xffff;pointer=ctypes.c_void_p(symbol)
        else:symbol=string(offset(value)+2);encoded=ctypes.c_char_p(symbol.encode());pointer=ctypes.cast(encoded,ctypes.c_void_p)
        if not kernel.GetProcAddress(dll._handle,pointer):missing.append(f'{library}!{symbol}')
        thunk+=8
    descriptor+=20
for error in missing:print('MISSING IMPORT',error,flush=True)
if missing:raise SystemExit(1)
print('All directly imported DLL entry points are present')
