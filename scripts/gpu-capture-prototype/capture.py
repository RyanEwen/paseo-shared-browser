"""Private, opt-in GPU-capture experiment. Never issues Shared Browser input receipts."""
import base64
import collections
import json
import os
import sys
import threading
import time

# Native capture libraries write diagnostics directly to file descriptor 1. Keep
# the parent's JSON pipe private, and route all library stdout to stderr first.
protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

# The caller verifies the pinned wheel before launching this child. No installation.
sys.path.insert(0, sys.argv[1])
import pixelflux

MAX_PACKET = 2 * 1024 * 1024
MAX_OUTPUTS = 4
lock = threading.Lock()
streams = {}
controller = pixelflux.ScreenCapture()


def is_key(data):
    """Identify an IDR access unit without trusting callback order after a drop."""
    offset = data.find(b"\0\0\1")
    while offset >= 0 and offset + 3 < len(data):
        if data[offset + 3] & 31 == 5:
            return True
        offset = data.find(b"\0\0\1", offset + 3)
    return False


def start_capture(message):
    """Start one bounded visual-only stream; queue loss requests an independent picture."""
    output = message['output']
    if output in streams:
        raise ValueError('Output already captured')
    settings = pixelflux.CaptureSettings()
    settings.use_wayland = True
    settings.display_id = output
    settings.capture_width = message['width']
    settings.capture_height = message['height']
    settings.scale = message['scale']
    settings.render_node_path = '/dev/dri/renderD128'
    settings.encode_node_path = '/dev/dri/renderD128'
    settings.codec = 'h264'
    settings.video_fullframe = True
    settings.omit_stripe_headers = True
    settings.video_streaming_mode = True
    settings.video_cbr_mode = True
    settings.video_bitrate_kbps = 24000
    settings.target_fps = 60.0
    settings.capture_cursor = False
    capture = pixelflux.ScreenCapture()
    state = {'capture': capture, 'packets': collections.deque(), 'active': True,
             'needs_key': True, 'dropped': 0, 'frames': 0, 'samples': []}
    streams[output] = state

    def receive(frame):
        data = bytes(frame)
        if len(data) > MAX_PACKET:
            return
        key = is_key(data)
        with lock:
            if not state['active']:
                return
            state['frames'] += 1
            if len(state['samples']) < 12000:
                state['samples'].append([time.monotonic_ns(), frame.capture_ns, frame.encode_end_ns])
            if len(state['packets']) >= 2:
                state['dropped'] += len(state['packets'])
                state['packets'].clear()
                state['needs_key'] = True
            if state['needs_key'] and not key:
                state['dropped'] += 1
                return
            state['needs_key'] = False
            state['packets'].append({'dataBase64': base64.b64encode(data).decode(),
                                     'captureNs': frame.capture_ns, 'frameId': frame.frame_id,
                                     'key': key, 'actionable': False})

    try:
        capture.start_capture(receive, settings)
    except BaseException:
        streams.pop(output, None)
        raise
    return capture.stream_info()


def command(message):
    """Allow only bounded output experiments over the owned parent's private pipe."""
    operation = message['operation']
    output = message.get('output', 0)
    if not isinstance(output, int) or output < 0 or output > MAX_OUTPUTS:
        raise ValueError('Invalid output')
    if operation == 'initialize':
        socket = pixelflux.ensure_wayland_display(640, 480, '/dev/dri/renderD128', 'true')
        if not socket:
            raise RuntimeError('Private compositor unavailable')
        return {'socket': socket}
    if operation == 'clock':
        return {'monotonicNs': time.monotonic_ns()}
    if operation == 'windows':
        windows = controller.list_windows()
        if len(windows) > 16:
            raise ValueError('Window limit reached')
        # Titles and app IDs do not establish identity and are deliberately omitted.
        return [{'nativeWindow': w[0], 'output': w[3]} for w in windows]
    if operation == 'create':
        width, height, scale = message['width'], message['height'], message['scale']
        if not 320 <= width <= 3840 or not 240 <= height <= 3840 or width % 2 or height % 2 or scale not in [1, 2]:
            raise ValueError('Invalid output geometry')
        return controller.create_output(output, width, height, output * 4096, 0, scale)
    if operation == 'move':
        return controller.move_window_to_output(message['nativeWindow'], output)
    if operation == 'snapshot':
        data = pixelflux.screenshot_png(output)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Snapshot limit reached')
        return base64.b64encode(data).decode()
    if operation == 'start':
        return start_capture(message)
    if operation == 'poll':
        state = streams[output]
        with lock:
            packets = list(state['packets'])
            state['packets'].clear()
            needs_key = state['needs_key']
        if needs_key:
            state['capture'].request_idr_frame()
        return packets
    if operation == 'info':
        return streams[output]['capture'].stream_info()
    if operation == 'stats':
        state = streams[output]
        with lock:
            return {'frames': state['frames'], 'dropped': state['dropped'],
                    'samples': state['samples'][:], 'info': state['capture'].stream_info()}
    if operation == 'stop':
        state = streams.pop(output)
        with lock:
            state['active'] = False
            state['packets'].clear()
        state['capture'].stop_capture()
        return True
    if operation == 'outputs':
        return controller.list_outputs()
    raise ValueError('Unknown operation')


try:
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            break
        if len(line) > 65536 or not line.endswith(b'\n'):
            raise ValueError('Command bound exceeded')
        message = json.loads(line)
        try:
            result = command(message)
            response = {'id': message['id'], 'result': result}
        except Exception as error:
            response = {'id': message['id'], 'error': str(error)[:500]}
        protocol_output.write(json.dumps(response) + '\n')
        protocol_output.flush()
finally:
    for state in list(streams.values()):
        with lock:
            state['active'] = False
            state['packets'].clear()
        state['capture'].stop_capture()
