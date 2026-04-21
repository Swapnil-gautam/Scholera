"""Generate quizzes from course materials using Gemini."""

from __future__ import annotations

import json
import logging
import re

from google import genai

from scholera.config import settings
from scholera.retrieval.hybrid_search import hybrid_retrieve

logger = logging.getLogger(__name__)

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


_QUIZ_SYSTEM_PROMPT = (
    'You are a quiz generator for the university course "{course_title}". '
    "Create multiple-choice questions that test understanding of the material.\n\n"
    "Rules:\n"
    "- Base ALL questions on the provided lecture materials below.\n"
    "- Each question must have exactly 4 options: A, B, C, D.\n"
    "- Exactly one option must be correct.\n"
    "- Include a brief explanation for why the correct answer is right.\n"
    "- Questions should range from conceptual understanding to application.\n"
    "- Do NOT create trivial or trick questions.\n"
    "- Use LaTeX notation for mathematical expressions if needed.\n\n"
    "You MUST respond with valid JSON only — no markdown, no code fences.\n"
    "Return a JSON array of question objects with this exact schema:\n"
    "[\n"
    '  {{\n'
    '    "question_text": "...",\n'
    '    "option_a": "...",\n'
    '    "option_b": "...",\n'
    '    "option_c": "...",\n'
    '    "option_d": "...",\n'
    '    "correct_option": "A",\n'
    '    "explanation": "..."\n'
    '  }}\n'
    "]\n"
)


def _format_context(retrieved: list[dict]) -> str:
    parts = []
    for i, chunk in enumerate(retrieved):
        meta = chunk.get("metadata", {})
        lecture_num = meta.get("lecture_number", "?")
        page_num = meta.get("page_number", "?")
        chunk_type = meta.get("chunk_type", "slide")

        if chunk_type == "lecture_summary":
            header = f"[Lecture {lecture_num} Summary]"
        elif chunk_type == "topic_summary":
            header = "[Topic Summary]"
        else:
            header = f"[Lecture {lecture_num}, Slide {page_num}]"

        parts.append(f"--- Source {i + 1}: {header} ---\n{chunk['text']}")
    return "\n\n".join(parts)


def _parse_questions(raw_text: str) -> list[dict]:
    """Extract the JSON array from Gemini's response, tolerating markdown fences."""
    text = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)```", text)
    if fence_match:
        text = fence_match.group(1).strip()

    questions = json.loads(text)
    if not isinstance(questions, list):
        raise ValueError("Expected a JSON array of questions")

    valid = []
    for q in questions:
        if all(k in q for k in ("question_text", "option_a", "option_b",
                                 "option_c", "option_d", "correct_option")):
            q["correct_option"] = q["correct_option"].upper().strip()
            if q["correct_option"] in ("A", "B", "C", "D"):
                valid.append(q)
    return valid


async def generate_quiz(
    course_id: str,
    course_title: str,
    topic: str,
    num_questions: int = 5,
    lecture_number: int | None = None,
) -> dict:
    query = topic
    if lecture_number:
        query = f"Lecture {lecture_number}: {topic}"

    retrieved = hybrid_retrieve(course_id, query)
    if not retrieved:
        raise ValueError("No relevant course materials found for this topic.")

    context = _format_context(retrieved)
    system = _QUIZ_SYSTEM_PROMPT.format(course_title=course_title)

    prompt = (
        f"{system}\n\n"
        f"=== COURSE MATERIALS ===\n{context}\n"
        f"=== END MATERIALS ===\n\n"
        f"Generate exactly {num_questions} multiple-choice questions about: {topic}\n"
        f"Return ONLY the JSON array."
    )

    client = _get_client()
    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=prompt,
    )

    raw = response.text or ""
    questions = _parse_questions(raw)
    if not questions:
        raise ValueError("Failed to generate valid quiz questions. Please try again.")

    return {
        "title": f"Quiz: {topic}",
        "topic": topic,
        "lecture_number": lecture_number,
        "questions": questions,
    }
