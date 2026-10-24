# Google APIs from this sandbox

`$GOOGLE_API_URL` reaches your user's own Google account. Call it with plain `curl` and **no
token**: the proxy adds the credential. If it answers `503 Google não configurado`, the account is
not connected yet; say so instead of retrying.

Paths are the official REST paths under these prefixes. Everything else answers 403.

| API      | Prefix under `$GOOGLE_API_URL`            | Official base it stands for              |
| -------- | ----------------------------------------- | ---------------------------------------- |
| Gmail    | `/gmail/v1` (uploads: `/upload/gmail/v1`) | `https://gmail.googleapis.com/gmail/v1`  |
| Sheets   | `/sheets/v4`                              | `https://sheets.googleapis.com/v4`       |
| Calendar | `/calendar/v3`                            | `https://www.googleapis.com/calendar/v3` |
| Drive    | `/drive/v3` (uploads: `/upload/drive/v3`) | `https://www.googleapis.com/drive/v3`    |

Path segments must not contain `%2F`, `%2E` or `..`. Put anything with a slash in it, such as a
sheet range whose tab name has `/`, in the query string instead.

## Gmail

```sh
G="$GOOGLE_API_URL/gmail/v1/users/me"
curl -s "$G/messages?q=is:unread&maxResults=10"                  # ids of matching messages
curl -s "$G/messages/MSG_ID?format=full"                          # one message
curl -s -X POST "$G/messages/MSG_ID/modify" -H 'content-type: application/json' \
  -d '{"removeLabelIds":["INBOX"]}'                               # archive
curl -s -X POST "$G/messages/MSG_ID/trash"                        # move to trash (prefer this)
curl -s -X DELETE "$G/messages/MSG_ID"                            # delete for good: only when asked
```

Send: build the RFC 822 message, base64url-encode it, post it as `raw`.

```sh
python3 - <<'PY' > /tmp/mail.json
import base64, json
from email.message import EmailMessage
m = EmailMessage()
m["To"] = "alguem@example.com"; m["Subject"] = "Assunto"
m.set_content("Texto do e-mail")
print(json.dumps({"raw": base64.urlsafe_b64encode(m.as_bytes()).decode()}))
PY
curl -s -X POST "$G/messages/send" -H 'content-type: application/json' -d @/tmp/mail.json
```

## Sheets

```sh
S="$GOOGLE_API_URL/sheets/v4/spreadsheets"
curl -s "$S/SHEET_ID?fields=sheets.properties.title"              # tab names
curl -s -G "$S/SHEET_ID/values:batchGet" --data-urlencode "ranges=Gastos!A1:F50"
curl -s -X POST "$S/SHEET_ID/values/Gastos!A1:append?valueInputOption=USER_ENTERED" \
  -H 'content-type: application/json' -d '{"values":[["24/10/2026","Mercado",210.50]]}'
```

Find a spreadsheet by name through Drive (below), with
`q=name contains 'Planilha' and mimeType='application/vnd.google-apps.spreadsheet'`.

## Calendar

```sh
C="$GOOGLE_API_URL/calendar/v3/calendars/primary/events"
curl -s -G "$C" --data-urlencode "timeMin=2026-10-24T00:00:00-03:00" \
  --data-urlencode "singleEvents=true" --data-urlencode "orderBy=startTime"
curl -s -X POST "$C" -H 'content-type: application/json' -d '{"summary":"Dentista",
  "start":{"dateTime":"2026-10-30T14:00:00-03:00"},"end":{"dateTime":"2026-10-30T15:00:00-03:00"}}'
```

## Drive

```sh
D="$GOOGLE_API_URL/drive/v3/files"
curl -s -G "$D" --data-urlencode "q=name contains 'nota'" --data-urlencode "fields=files(id,name,mimeType)"
curl -s "$D/FILE_ID?alt=media" -o arquivo                          # download
curl -s -X POST "$GOOGLE_API_URL/upload/drive/v3/files?uploadType=multipart" \
  -F 'metadata={"name":"recibo.pdf"};type=application/json' -F 'file=@recibo.pdf'
```

Before you send, delete, or change something the user did not clearly ask for, confirm with them
first.
