# -*- coding: utf-8 -*-
"""米家云接口登录与取数（miservice 实现）
用法:
  python mijia_login.py login [验证码]  # 登录并保存 token（OTP 走参数或 data/mijia_otp.txt）
  python mijia_login.py props          # 读摄像机属性
  python mijia_login.py events         # 读报警事件
账号文件: Ai_jiankong/data/mijia_account.json  ({"username": "...", "password": "..."})
Token 文件: Ai_jiankong/data/mijia_token.json   (自动生成)
"""
import asyncio, json, sys, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACC_FILE = os.path.join(BASE, "data", "mijia_account.json")
TOKEN_FILE = os.path.join(BASE, "data", "mijia_token.json")
DID = "129586269"


def load_account():
    with open(ACC_FILE, encoding="utf-8") as f:
        return json.load(f)


async def main():
    from miservice import MiAccount, MiIOService

    action = sys.argv[1] if len(sys.argv) > 1 else "login"
    cfg = load_account()
    async def _otp(method):
        if len(sys.argv) > 2 and sys.argv[2].strip():
            return sys.argv[2].strip()
        p = os.path.join(BASE, "data", "mijia_otp.txt")
        if os.path.isfile(p):
            os.remove(p)
        print("[OTP] waiting for data/mijia_otp.txt ...", flush=True)
        for _ in range(240):
            if os.path.isfile(p):
                code = open(p, encoding="utf-8").read().strip()
                if code:
                    print("[OTP] got", flush=True)
                    return code
            await asyncio.sleep(1)
        raise Exception("timeout waiting otp file")
    acc = MiAccount(None, cfg["username"], cfg["password"], token_store=TOKEN_FILE, otp_callback=_otp)

    if action == "login":
        sid = sys.argv[3] if len(sys.argv) > 3 else "xiaomiio"
        dev_file = os.path.join(BASE, "data", "mijia_device.json")
        if os.path.isfile(dev_file):
            try:
                with open(dev_file, encoding="utf-8") as fh:
                    acc.token = {"deviceId": json.load(fh)["deviceId"]}
            except Exception:
                pass
        ok = await acc.login(sid)
        print("login ok:", ok)
        if not ok:
            print("login error:", acc._login_error)
            sys.exit(1)
        try:
            with open(dev_file, "w", encoding="utf-8") as fh:
                json.dump({"deviceId": acc.token.get("deviceId", "")}, fh)
        except Exception:
            pass
        print("token keys:", list(acc.token.keys()))
        return

    if action == "selftest":
        acc.token = await acc.token_store.load_token()
        if not acc.token:
            print("no token, please login first"); sys.exit(1)
        print("token keys:", list(acc.token.keys()))
        for sidkey in ("xiaomiio", "mijia"):
            if sidkey in acc.token:
                print("sid", sidkey, "ssecurity_len", len(acc.token[sidkey][0] or ""))
        for base in ("https://core.api.mijia.tech/app", "https://api.mijia.tech"):
            try:
                acc2 = MiAccount(None, "", "", token_store=TOKEN_FILE)
                acc2.token = acc.token
                svc2 = MiIOService(acc2)
                svc2.server = base
                r = await svc2.miot_get_props(DID, [(2, 1), (2, 3), (2, 7), (1, 2)])
                print("OK", base, "props:", r)
            except Exception as e:
                print("FAIL", base, repr(e)[:300])
        return
    svc = MiIOService(acc)
    if action == "props":
        # 摄像机 camera-control: siid=2, piid=1 (开关), piid=3 (夜视), piid=7 (水印)
        r = await svc.miot_get_props(DID, [(2, 1), (2, 3), (2, 7), (1, 2)])
        print(json.dumps(r, ensure_ascii=False))
        return
    if action == "events":
        # 通过 miot 云读事件属性（先试探）
        r = await svc.miot_get_props(DID, [(2, 8)])
        print(json.dumps(r, ensure_ascii=False))
        return
    print("unknown action:", action)


if __name__ == "__main__":
    asyncio.run(main())
