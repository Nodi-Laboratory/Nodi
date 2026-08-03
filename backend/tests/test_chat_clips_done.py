import inspect

from app.routers import chat


def test_done_event_includes_clips_field():
    src = inspect.getsource(chat)
    # done 이벤트 딕셔너리에 clips 키가 실린다
    assert '"clips": skill_clips' in src
    # outcome에서 clips를 받는다
    assert "skill_clips" in src and "payload.clips" in src
