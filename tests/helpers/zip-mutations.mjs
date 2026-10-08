import { execFileSync } from 'node:child_process';

// Independent Python reader locates a real writer's entry; only test fixtures
// edit binary fields. Production ZIP parsing remains owned by yauzl.
export function mutateZip(input, output, kind) {
  execFileSync('python3', ['-c', String.raw`import sys,struct,zipfile
source,dest,kind=sys.argv[1:]
with zipfile.ZipFile(source) as z:
 info=z.getinfo('run/report.json')
 local=info.header_offset
b=bytearray(open(source,'rb').read())
assert b[local:local+4]==b'PK\x03\x04'
n=struct.unpack_from('<H',b,local+26)[0]
assert bytes(b[local+30:local+30+n])==b'run/report.json'
if kind in ('local-path','local-name'):
 replacement=b'../reportx.json' if kind=='local-path' else b'run/config.json'
 assert len(replacement)==n
 b[local+30:local+30+n]=replacement
elif kind in ('local-encrypted','local-strong-encrypted','local-flags','local-descriptor'):
 mask={'local-encrypted':1,'local-strong-encrypted':0x40,'local-flags':0x800,'local-descriptor':8}[kind]
 flags=struct.unpack_from('<H',b,local+6)[0]
 struct.pack_into('<H',b,local+6,flags^mask)
elif kind=='local-compression':struct.pack_into('<H',b,local+8,0 if info.compress_type else 8)
elif kind in ('local-crc','local-compressed-size','local-uncompressed-size'):
 offset={'local-crc':14,'local-compressed-size':18,'local-uncompressed-size':22}[kind]
 value=struct.unpack_from('<I',b,local+offset)[0]
 struct.pack_into('<I',b,local+offset,value^1)
elif kind=='descriptor-values':
 assert info.flag_bits&8
 struct.pack_into('<III',b,local+14,info.CRC,info.compress_size,info.file_size)
elif kind in ('osx-symlink','osx-special','osx-directory','osx-regular'):
 pos=0
 while True:
  pos=b.find(b'PK\x01\x02',pos)
  if pos<0:raise Exception('missing central header')
  count=struct.unpack_from('<H',b,pos+28)[0]
  if bytes(b[pos+46:pos+46+count])==b'run/report.json':break
  pos+=4
 mode={'osx-symlink':0o120777,'osx-special':0o060000,'osx-directory':0o040755,'osx-regular':0o100644}[kind]
 b[pos+5]=19
 struct.pack_into('<I',b,pos+38,mode<<16)
else:raise Exception('unknown mutation')
open(dest,'wb').write(b)
`, input, output, kind]);
}

export function repackPythonZip(input, output, compression) {
  execFileSync('python3', ['-c', String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:data=[(name,z.read(name)) for name in z.namelist()]
method=zipfile.ZIP_STORED if sys.argv[3]=='stored' else zipfile.ZIP_DEFLATED
with zipfile.ZipFile(sys.argv[2],'w',method) as z:
 for name,content in data:z.writestr(name,content)
`, input, output, compression]);
}
