"""Four-dimensional CEFR profile assembly (Master PRD §22).

A single CEFR level averages away asymmetric proficiency — a learner can be B2
in writing and A2 in speaking, and calling that "B1" is neither accurate nor
actionable. So the profile carries one level per skill. §22.1 fixes how each
dimension is sourced, and Phase 1 can only populate some of them:

  Writing   — assessed directly by the Writing Evaluation Engine.
  Reading   — Phase-1 *proxy from writing* (§22.1); no reading module until Phase 3.
  Speaking  — from Voice Agent sessions; the Voice pipeline isn't built until
              Phase 2, so speaking is `pending`.
  Listening — Phase-1 proxy *from speaking* (§22.1). Because speaking is pending,
              listening is pending too — you can't proxy off a value that
              doesn't exist yet.

Each dimension carries a `source` — assessed | proxy | pending — so the §22.2
radar can label a skill honestly ("proxy — Phase 3", "pending — Phase 2")
instead of presenting a guess as a measured level. That honesty is the whole
point of a 4D profile; fabricating the three unbuilt skills would defeat it.
"""

from dataclasses import dataclass

# CEFR ladder for the proxy only. The band→level mapping lives in each exam
# config's `cefr_for`, not here.
_CEFR_ORDER = ("A1", "A2", "B1", "B2", "C1", "C2")

ASSESSED = "assessed"
PROXY = "proxy"
PENDING = "pending"

_VOICE_PENDING = "Speaking is assessed by the Voice Agent — Phase 2"
_LISTENING_PENDING = "Proxy from speaking, which is pending — Phase 2"
_READING_PROXY = "Phase-1 proxy from writing (PRD §22.1)"


@dataclass(frozen=True)
class Dimension:
    level: str | None
    source: str
    note: str | None = None


@dataclass(frozen=True)
class CefrProfile:
    speaking: Dimension
    listening: Dimension
    reading: Dimension
    writing: Dimension

    def to_dict(self) -> dict:
        return {
            "speaking": _dim_dict(self.speaking),
            "listening": _dim_dict(self.listening),
            "reading": _dim_dict(self.reading),
            "writing": _dim_dict(self.writing),
        }


def _dim_dict(d: Dimension) -> dict:
    return {"level": d.level, "source": d.source, "note": d.note}


def reading_proxy_from_writing(writing_cefr: str | None) -> str | None:
    """Phase-1 reading proxy (§22.1). Conservative: reading *mirrors* writing
    until a real reading module (Phase 3) replaces it. Receptive skills often
    lead productive ones, but bumping the level on an untested skill would be a
    guess dressed as data — so we mirror rather than inflate."""
    return writing_cefr if writing_cefr in _CEFR_ORDER else None


def placement_profile(writing_cefr: str | None) -> CefrProfile:
    """Initialise the 4D profile from a placement writing score. Writing is
    assessed; reading is proxied from it; speaking and listening stay pending
    until the Voice pipeline exists (Phase 2)."""
    return CefrProfile(
        writing=Dimension(writing_cefr, ASSESSED),
        reading=Dimension(reading_proxy_from_writing(writing_cefr), PROXY, _READING_PROXY),
        speaking=Dimension(None, PENDING, _VOICE_PENDING),
        listening=Dimension(None, PENDING, _LISTENING_PENDING),
    )


def profile_from_stored(
    *,
    cefr_writing: str | None,
    cefr_reading: str | None,
    cefr_speaking: str | None,
    cefr_listening: str | None,
) -> CefrProfile:
    """Build the profile view from stored learner_profiles columns, applying the
    same §22.1 source rules to whatever has been populated so far. An unset
    skill reads as `pending` with the reason it isn't available yet."""
    return CefrProfile(
        writing=Dimension(cefr_writing, ASSESSED if cefr_writing else PENDING),
        reading=Dimension(cefr_reading, PROXY if cefr_reading else PENDING, _READING_PROXY),
        speaking=Dimension(
            cefr_speaking,
            ASSESSED if cefr_speaking else PENDING,
            None if cefr_speaking else _VOICE_PENDING,
        ),
        listening=Dimension(
            cefr_listening,
            PROXY if cefr_listening else PENDING,
            None if cefr_listening else _LISTENING_PENDING,
        ),
    )
