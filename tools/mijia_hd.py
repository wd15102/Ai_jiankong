# -*- coding: utf-8 -*-
"""米家报警视频取高清帧: python tools/mijia_hd.py <fileId> <outJpg>
依赖 dsh runtime python(micloud/Crypto); 输出成功返回 0, 失败返回非 0。
"""
import sys, os, json, re, subprocess, requests
from urllib.parse import urlparse, urlencode
from Crypto.Cipher import AES
from micloud.miutils import gen_nonce, signed_nonce, encrypt_rc4

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = os.path.join(ROOT, "data", "mijia_token.json")
FFMPEG = os.path.join(ROOT, "bin", "ffmpeg.exe")
DID = "129586269"

def die(msg):
    print("[mijia-hd] " + str(msg), file=sys.stderr)
    sys.exit(1)

def sha1_sign(method, url, dat, nonce):
    p = urlparse(url).path
    if p[:5] == "/app/": p = p[4:]
    arr = [str(method).upper(), p]
    for k, v in dat.items(): arr.append(str(k) + "=" + str(v))
    arr.append(nonce)
    import hashlib, base64
    return base64.b64encode(hashlib.sha1("&".join(arr).encode()).digest()).decode()

def rc4_params(method, url, params, ss):
    nonce = gen_nonce(); sn = signed_nonce(ss, nonce)
    params["rc4_hash__"] = sha1_sign(method, url, params, sn)
    for k, v in list(params.items()): params[k] = encrypt_rc4(sn, str(v))
    params["signature"] = sha1_sign(method, url, params, sn)
    params["ssecurity"] = ss
    params["_nonce"] = nonce
    return params

def main():
    if len(sys.argv) < 3: die("usage: mijia_hd.py <fileId> <outJpg>")
    file_id = sys.argv[1]
    out = sys.argv[2]
    if not os.path.exists(TOKEN): die("no token file")
    tok = json.load(open(TOKEN, encoding="utf-8"))
    ss = tok["xiaomiio"][0]; st = tok["xiaomiio"][1]; uid = str(tok["userId"])
    H = {"Cookie": "serviceToken=" + st + "; yetAnotherServiceToken=" + st + "; userId=" + uid}
    api = "https://business.smartcamera.api.io.mi.com/common/app/m3u8"
    rqd = {"did": DID, "model": "mijia.camera.v3", "fileId": file_id, "isAlarm": True, "videoCodec": "H265"}
    params = rc4_params("GET", api, {"data": json.dumps(rqd, separators=(",", ":"))}, ss)
    params["yetAnotherServiceToken"] = st
    r = requests.get(api + "?" + urlencode(params), headers=H, timeout=40)
    if r.status_code != 200: die("m3u8 status " + str(r.status_code))
    txt = r.text
    mk = re.search(r'URI="([^"]+)"', txt)
    mi = re.search(r"IV=0x([0-9A-Fa-f]+)", txt)
    segs = [ln.strip() for ln in txt.splitlines() if ln.strip().startswith("https://")]
    if not (mk and mi and segs): die("m3u8 parse fail")
    iv = bytes.fromhex(mi.group(1))
    key = requests.get(mk.group(1), headers=H, timeout=30).content
    if len(key) not in (16, 24, 32): die("key len " + str(len(key)))
    plain = b""
    for u in segs:
        d = requests.get(u, headers=H, timeout=90).content
        c = AES.new(key, AES.MODE_CBC, iv)
        plain += c.decrypt(d)
    tmp = out + ".ts"
    open(tmp, "wb").write(plain)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    r2 = subprocess.run([FFMPEG, "-y", "-i", tmp, "-frames:v", "1", "-q:v", "2", out], capture_output=True, timeout=120)
    try: os.unlink(tmp)
    except Exception: pass
    if r2.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1000:
        die("ffmpeg fail")
    print(out)

if __name__ == "__main__":
    main()