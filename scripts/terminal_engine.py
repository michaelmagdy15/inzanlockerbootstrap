import sys
import re
import urllib.request
import urllib.error
import json
import os

UUID_REGEX = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
API_SCAN_URL = os.environ.get("LOCKER_API_SCAN_URL", "http://localhost:3000/api/terminal/scan")
API_VACATE_URL = os.environ.get("LOCKER_API_VACATE_URL", "http://localhost:3000/api/terminal/vacate")

def main():
    print("====================================================")
    print("Gym Locker Terminal Engine Active")
    print("Waiting for QR scans (emulating standard USB stdin)...")
    print("Commands:")
    print("  /vacate or -v : Switch next scan to VACATE mode")
    print("  /open or -o   : Switch next scan to OPEN mode (Default)")
    print("====================================================")
    
    current_mode = "open"
    
    while True:
        try:
            prompt = "[OPEN] Scan Code: " if current_mode == "open" else "[VACATE] Scan Code: "
            sys.stdout.write(prompt)
            sys.stdout.flush()
            
            line = sys.stdin.readline()
            if not line:
                break
            
            scanned = line.strip()
            if not scanned:
                continue
                
            if scanned in ("/vacate", "-v"):
                current_mode = "vacate"
                print("\033[93mMode switched to: VACATE locker\033[0m")
                continue
            elif scanned in ("/open", "-o"):
                current_mode = "open"
                print("\033[94mMode switched to: OPEN locker\033[0m")
                continue
            
            if not UUID_REGEX.match(scanned):
                print("\033[91mError: Scanned code is not a valid Locker Token (UUIDv4 format).\033[0m")
                continue
                
            # Process based on mode
            if current_mode == "open":
                url = API_SCAN_URL
                payload = {"locker_token": scanned}
            else:
                url = API_VACATE_URL
                payload = {"locker_token": scanned}
                
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                url, 
                data=data, 
                headers={'Content-Type': 'application/json'}
            )
            
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    res_body = response.read().decode('utf-8')
                    result = json.loads(res_body)
                    
                    if result.get("success"):
                        if current_mode == "open":
                            locker_id = result.get("locker_id")
                            action = result.get("action")
                            if action == "allocate":
                                print(f"\033[92mSUCCESS: Allocated Locker \033[1m{locker_id}\033[0m\033[92m (First Scan)!\033[0m")
                            else:
                                print(f"\033[92mSUCCESS: Unlocked Locker \033[1m{locker_id}\033[0m\033[92m!\033[0m")
                        else:
                            print(f"\033[92mSUCCESS: {result.get('message')}\033[0m")
                    else:
                         print(f"\033[91mFailed: {result.get('message')}\033[0m")
            except urllib.error.HTTPError as e:
                try:
                    err_msg = json.loads(e.read().decode('utf-8')).get('message', str(e))
                except Exception:
                    err_msg = str(e)
                print(f"\033[91mAPI Error: {err_msg}\033[0m")
            except urllib.error.URLError as e:
                print(f"\033[91mNetwork Error connecting to API: {e.reason}\033[0m")
                
            # Reset mode back to default open mode after a vacate operation
            if current_mode == "vacate":
                current_mode = "open"
                print("\033[94mAuto-reset mode to: OPEN locker\033[0m")
                
        except KeyboardInterrupt:
            print("\nExiting Terminal Engine.")
            break
        except Exception as e:
            print(f"Unexpected error: {str(e)}")

if __name__ == "__main__":
    main()
