from onebox_rag.mail.reply import latest_reply

QUOTE = '<div class="gmail_quote">On Fri, Bob wrote:<blockquote>Which courier?</blockquote></div>'
FORWARD = (
    '<div class="gmail_quote">---------- Forwarded message ---------<br>From: Bob<br>'
    "<div>Invoice 4471 is due on Friday.</div></div>"
)


def test_keeps_the_reply_drops_quotes_and_keeps_forwards_whole() -> None:
    reply = latest_reply(f"<div>Parcelforce.</div>{QUOTE}", "Parcelforce.\n\n> Which courier?")
    assert reply is not None and b"Parcelforce" in reply.data
    assert b"Which courier" not in reply.data

    text = (
        "FYI\n\n---------- Forwarded message ---------\nFrom: Bob\n\nInvoice 4471 is due on Friday."
    )
    forward = latest_reply(f"<div>FYI</div>{FORWARD}", text)
    assert forward is not None and b"Invoice 4471" in forward.data

    plain = latest_reply(None, "Yes.\n\nOn Mon, Nov 3, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> old")
    assert plain is not None and (plain.data, plain.mime_type) == (b"Yes.", "text/plain")
    assert latest_reply("", "  ") is None
