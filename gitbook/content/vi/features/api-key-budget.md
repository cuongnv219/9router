# Ngân sách USD/ngày theo API Key

Chia sẻ một 9Router cho nhiều người, mỗi người một API key với hạn mức chi tiêu riêng tính bằng USD/ngày. Hết hạn mức thì key bị chặn cứng (HTTP 429) cho tới 00:00 giờ Việt Nam.

---

## Tổng quan

- **Mỗi key một ngân sách riêng** — không dùng chung giữa các key.
- **Ngày ngân sách theo giờ Việt Nam** (Asia/Ho_Chi_Minh, UTC+7). Reset lúc 00:00, không phụ thuộc giờ server hay lúc tạo key.
- **Chặn cứng trước khi gọi provider** — request bị từ chối không tốn token nào.
- **An toàn khi chạy song song** — nhiều request cùng lúc của một key không thể vượt hạn mức; fallback sang account/model khác cũng không lách được.
- **Lịch sử được giữ lại** — mỗi ngày là một bản ghi riêng; sang ngày mới thì bắt đầu từ $0.

Key không đặt ngân sách hoạt động y như trước (không giới hạn).

---

## Đặt ngân sách cho key

```
Dashboard → Endpoint → API Keys
```

1. Tạo key mới (hoặc chọn key có sẵn) và đặt tên theo người dùng, ví dụ `nam-dev`.
2. Bấm **Set budget**, nhập số USD/ngày (ví dụ `5`), bấm **Save**.
3. Gửi key cho người dùng.

Mỗi key hiển thị:

```
Today $1.2300 / $5.0000 (25%)  · left $3.7700  · $0.4000 in flight
████░░░░░░░░░░░░
```

- **Today** — đã tiêu + đang giữ chỗ cho request chưa xong.
- **left** — còn lại hôm nay.
- **in flight** — tiền đang được giữ cho các request đang chạy; sẽ được trả lại phần thừa khi request kết thúc.

Để bỏ giới hạn: **Edit**, xoá trống ô, **Save**.
Để tạm khoá key: tắt công tắc của key (Pause). Để thu hồi hẳn: xoá key — lịch sử chi tiêu vẫn được giữ.

### Xem lịch sử

Bấm **History** trên key để xem:

- **By day** — chi tiêu và số request từng ngày.
- **By model** — chi tiêu theo provider/model trong ngày.
- **Requests** — từng request: thời gian, model, trạng thái, chi phí.

Cột trạng thái:

| Giá trị | Nghĩa |
|---|---|
| `provider_usage` | Tính theo usage thật provider trả về |
| `estimated` | Provider không trả usage (client ngắt stream, lỗi giữa chừng) → tính theo ước lượng |
| `provider_usage_late` | Usage thật tới sau khi đã tính ước lượng → chỉ cộng phần chênh |
| `released` | Request lỗi hoặc không sinh nội dung → không tính tiền |
| `expired` | Request bị treo quá 30 phút (crash…) → tính trọn phần đã giữ chỗ |

---

## Cách tính tiền

### Trước khi gọi provider: giữ chỗ

Mỗi lần gọi provider, 9Router **giữ chỗ trước** chi phí lớn nhất mà request có thể tốn:

```
giữ chỗ = input ước lượng × giá input + output tối đa × giá output
```

Output tối đa **không phải** luôn là `max_tokens` client gửi, vì một số translator/provider tự nâng nó lên:

| Trường hợp | Output tối đa được giữ chỗ |
|---|---|
| Request thường | `max_tokens` của client (không có thì 64000) |
| Có `tools` (Claude Code, Cursor, Cline…) | ít nhất **32000** |
| Có thinking `budget_tokens` | ít nhất `budget_tokens + 1024` |
| Có reasoning effort | output tối đa của model |
| Codex, grok-cli (bỏ qua `max_tokens`) | output tối đa của model |

Luôn bị giới hạn bởi output tối đa của model (ví dụ gpt-4o: 16384).

Nếu số dư không đủ cho phần giữ chỗ → **429**, không gọi provider.

### Sau khi xong: tính tiền thật

Chi phí thật lấy từ usage provider trả về và bảng giá trong **Pricing** (input, output, cached, cache creation, reasoning). Phần giữ chỗ thừa được trả lại ngay.

### Ví dụ

Key ngân sách $5/ngày, model `claude-sonnet-4-6` ($15/M output), request có tools:

```
giữ chỗ ≈ 32000 × $15/M = $0.48 (+ input)
chi phí thật (2000 token output) ≈ $0.03 (+ input)
→ trả lại ≈ $0.45
```

> **Lưu ý:** vì request có tools giữ chỗ tới ~$0.48, khi chỉ còn dưới mức đó trong ngày thì request có tools sẽ bị 429 dù số dư chưa về 0. Đây là đánh đổi có chủ đích để **không bao giờ vượt hạn mức**.

### Request vắt qua nửa đêm

Request bắt đầu lúc 23:59 và kết thúc 00:01 được tính vào **ngày bắt đầu** (ngày đã cho phép nó chạy).

---

## Khi hết ngân sách

Client nhận:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 18727
X-Budget-Day: 2026-10-24

{
  "error": {
    "message": "Daily budget exhausted for this API key: $4.9500 spent + $0.0000 in flight of $5.00 (resets 00:00 Asia/Ho_Chi_Minh)",
    "type": "rate_limit_error",
    "code": "daily_budget_exceeded"
  }
}
```

`Retry-After` = số giây tới 00:00 giờ Việt Nam. Các tool như Claude Code sẽ báo lỗi rate limit; người dùng chờ sang ngày hoặc nhờ admin nâng ngân sách (có hiệu lực ngay cho request mới).

---

## Giới hạn với key có ngân sách

Để bảo đảm không có đường nào tiêu tiền mà không bị tính, key có ngân sách **chỉ** gọi được các endpoint chat:

| Được phép | Bị chặn (403) |
|---|---|
| `/v1/chat/completions` | `/v1/embeddings` |
| `/v1/messages` | `/v1/images/generations` |
| `/v1/responses` | `/v1/audio/speech`, `/v1/audio/transcriptions` |
| `/v1beta/models/...:generateContent` | `/v1/videos/*` |
| `/v1/api/chat` (Ollama) | `/v1/search`, `/v1/web/fetch` |
| `GET /v1/models` | `/v1/systemone`, Gemini native TTS |

Ngoài ra:

- **Model chưa có giá** (hoặc giá $0) bị từ chối với lỗi 403. Muốn cho phép: vào **Pricing** đặt giá cho model đó.
- **Combo dạng Smart Router** vẫn dùng được, nhưng bỏ qua bước System One chọn model (bước đó là một lời gọi provider không tính tiền) và đi theo thứ tự combo.

Cần các endpoint bị chặn? Dùng một key **không đặt ngân sách** cho việc đó.

---

## Gửi key qua header nào cũng được

Ngân sách áp dụng như nhau dù key gửi qua `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` hay `?key=`.

---

## API cho admin

Tất cả cần đăng nhập dashboard (hoặc CLI token).

```bash
# Tạo key với ngân sách $5/ngày
curl -X POST http://localhost:20128/api/keys \
  -H "Content-Type: application/json" -b "auth_token=..." \
  -d '{"name":"nam-dev","dailyBudgetUsd":5}'

# Đổi ngân sách / tên / tạm khoá (null = không giới hạn)
curl -X PUT http://localhost:20128/api/keys/<id> \
  -H "Content-Type: application/json" -b "auth_token=..." \
  -d '{"dailyBudgetUsd":10,"name":"nam","isActive":true}'

# Chi tiêu theo ngày, theo model và từng request (day=YYYY-MM-DD, mặc định hôm nay)
curl "http://localhost:20128/api/keys/<id>/usage?day=2026-10-24" -b "auth_token=..."

# Nhật ký thao tác admin (tạo/sửa/xoá key)
curl "http://localhost:20128/api/audit-log" -b "auth_token=..."
```

`GET /api/keys` trả kèm `budget` (`spentUsd`, `reservedUsd`, `remainingUsd`, `requests`) cho key có ngân sách.

---

## Lưu ý vận hành

- **Chạy một host.** Hạn mức chính xác khi 9Router chạy trên một máy với SQLite native (Node ≥ 22.5 hoặc Bun). Không bảo đảm khi dùng fallback `sql.js` hoặc nhiều máy dùng chung một file DB.
- **Ước lượng input.** Input được ước lượng trước theo độ dài request; nếu input thật lớn hơn nhiều (ví dụ nhiều ảnh) hoặc provider không trả usage, một ngày có thể vượt hạn mức một chút.
- **Giá.** Chi phí tính theo bảng **Pricing**. Provider dạng subscription/OAuth được tính theo giá niêm yết tương đương — là thước đo để chia tài nguyên, không phải hoá đơn thật.
- **Bảo mật.** Nếu tắt `requireLogin`, ai truy cập được dashboard cũng sửa được ngân sách. Khi chia key cho người khác, hãy bật đăng nhập và đổi mật khẩu mặc định.
