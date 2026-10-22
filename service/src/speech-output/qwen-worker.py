"""Offline Qwen3-TTS worker. Text enters stdin; bounded PCM WAV exits stdout. No playback."""
import base64
import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path
sys.dont_write_bytecode = True
from segments import split_scripts

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model
    model = load_model(Path(sys.argv[1]))

for line in sys.stdin:
    try:
        request = json.loads(line)
        text = request['text']
        language = request['language']
        if not isinstance(text, str) or not text.strip() or len(text) > 1200 or language not in ('en', 'ko'):
            raise ValueError('invalid request')
        voice = 'Sohee'
        started = time.perf_counter()
        segments = split_scripts(text, language)
        if len(segments) > 12:
            raise ValueError('segment bounds')
        audio_parts = []
        sample_rate = 24000
        with contextlib.redirect_stdout(sys.stderr):
            for segment, segment_language in segments:
                chunks = list(model.generate_custom_voice(text=segment, speaker=voice,
                    language=segment_language, max_tokens=600,
                    instruct=('Speak warmly and naturally at a conversational pace.' if segment_language == 'English' else '따뜻하고 자연스럽게 대화하듯 말하세요.') if model.config.tts_model_size == '1b7' else None,
                    temperature=0.7, repetition_penalty=1.1, verbose=False, stream=False))
                if not chunks:
                    raise ValueError('no audio')
                sample_rate = chunks[0].sample_rate
                if sample_rate != 24000:
                    raise ValueError('unexpected sample rate')
                if audio_parts:
                    audio_parts.append(np.zeros(round(sample_rate * 0.08), dtype=np.float32))
                audio_parts.extend(np.asarray(chunk.audio) for chunk in chunks)
        audio = np.concatenate(audio_parts)
        if not np.isfinite(audio).all() or len(audio) > 24000 * 35:
            raise ValueError('audio bounds')
        output = io.BytesIO()
        sf.write(output, audio, sample_rate, format='WAV', subtype='PCM_16')
        wav = output.getvalue()
        if len(wav) > 2 * 1024 * 1024:
            raise ValueError('audio size')
        print(json.dumps({'wav': base64.b64encode(wav).decode(), 'voice': 'qwen3-tts:' + voice,
            'language': language, 'latencyMs': round((time.perf_counter() - started) * 1000)}), flush=True)
    except Exception as error:
        print(type(error).__name__, file=sys.stderr, flush=True)
        print(json.dumps({'error': 'Local neural synthesis failed.'}), flush=True)
