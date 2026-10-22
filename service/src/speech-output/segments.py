"""Preserve exact text while selecting native English/Korean synthesis for each script run."""
import re

# Unicode Script=Hangul, matching the service's reply-language selector. Include
# Jamo and enclosed/halfwidth forms without normalizing the person's exact text.
HANGUL = re.compile(
    '[\u1100-\u11ff\u302e-\u302f\u3131-\u318e\u3200-\u321e'
    '\u3260-\u327e\ua960-\ua97c\uac00-\ud7a3\ud7b0-\ud7c6'
    '\ud7cb-\ud7fb\uffa0-\uffbe\uffc2-\uffc7\uffca-\uffcf'
    '\uffd2-\uffd7\uffda-\uffdc]'
)


def split_scripts(text, language):
    segments = []
    current = ''
    current_language = None
    for character in text:
        script = 'Korean' if HANGUL.match(character) else 'English' if re.match('[A-Za-z]', character) else None
        if script and current_language and script != current_language:
            segments.append((current, current_language))
            current = ''
        if script:
            current_language = script
        current += character
    if current.strip():
        segments.append((current, current_language or ('English' if language == 'en' else 'Korean')))
    return segments
