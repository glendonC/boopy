import unittest
from segments import split_scripts


class ScriptSegmentsTest(unittest.TestCase):
    def test_preserves_exact_mixed_words_and_punctuation(self):
        text = 'It looks like a camel — 낙타 in Korean.'
        parts = split_scripts(text, 'ko')
        self.assertEqual(parts, [('It looks like a camel — ', 'English'), ('낙타 ', 'Korean'), ('in Korean.', 'English')])
        self.assertEqual(''.join(part[0] for part in parts), text)

    def test_pure_languages_stay_one_segment(self):
        self.assertEqual(split_scripts('사진에는 사막이 보여요.', 'ko'), [('사진에는 사막이 보여요.', 'Korean')])
        self.assertEqual(split_scripts('This is a photograph.', 'en'), [('This is a photograph.', 'English')])

    def test_neutral_prefix_and_numbers_are_preserved(self):
        text = '“사막” means desert, 1970-01-01.'
        self.assertEqual(''.join(part[0] for part in split_scripts(text, 'ko')), text)
        self.assertEqual(split_scripts('1970-01-01!', 'en'), [('1970-01-01!', 'English')])

    def test_decomposed_and_compatibility_jamo_keep_exact_text(self):
        for korean in ('사막', 'ㅅㅏㅁㅏㄱ'):
            text = 'Say ' + korean + ' in Korean.'
            parts = split_scripts(text, 'ko')
            self.assertEqual(parts, [('Say ', 'English'), (korean + ' ', 'Korean'), ('in Korean.', 'English')])
            self.assertEqual(''.join(part[0] for part in parts), text)

    def test_extended_enclosed_and_halfwidth_hangul_are_korean(self):
        for character in ('\ua960', '\ud7b0', '\ud7cb', '\u3200', '\u3260', '\uffa0', '\uffc2', '\uffca', '\uffd2', '\uffda', '\u302e'):
            self.assertEqual(split_scripts('A ' + character + ' B', 'en'),
                             [('A ', 'English'), (character + ' ', 'Korean'), ('B', 'English')])


if __name__ == '__main__':
    unittest.main()
