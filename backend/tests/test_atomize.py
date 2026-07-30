"""atomize 순수 함수 테스트 (TASK 6, D129) — 프롬프트 구성·파서 규약."""
from app.services import atomize


def test_build_atom_messages_프롬프트_구성():
    msgs = atomize.build_atom_messages("가야는 철과 토기 문화로 유명하다.", 3)
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert "가야는 철과 토기" in msgs[1]["content"]
    assert "3개" in msgs[1]["content"]
    assert "지시대명사" in msgs[1]["content"]


def test_parse_번호_기호_제거():
    content = "1. 가야 토기의 특징은?\n- 가야는 어디에 있었나?\n③ 철기 문화란?"
    out = atomize.parse_atom_questions(content, 5)
    assert out == ["가야 토기의 특징은?", "가야는 어디에 있었나?", "철기 문화란?"]


def test_parse_빈줄_중복_상한():
    content = "질문 하나?\n\n질문 하나?\n질문 둘?\n질문 셋?"
    assert atomize.parse_atom_questions(content, 2) == ["질문 하나?", "질문 둘?"]


def test_parse_빈_응답():
    assert atomize.parse_atom_questions("", 3) == []
