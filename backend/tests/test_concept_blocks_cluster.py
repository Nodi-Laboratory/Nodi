from app.services.concept_blocks import parse


def test_parse_returns_cluster():
    answer = "@concept: 명반응 | 광합성\n- 빛을 흡수한다\n@end\n@concept: 세포호흡\n- 에너지를 만든다\n@end"
    blocks = parse(answer)
    assert blocks[0]["cluster"] == "광합성"
    assert blocks[0]["title"] == "명반응"
    assert blocks[1]["cluster"] == ""   # | 없으면 빈 문자열
    assert blocks[1]["title"] == "세포호흡"
