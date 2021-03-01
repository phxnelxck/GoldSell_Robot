const config = require("./config.json");
const products = require("./products.json");
const phrases = require("./phrases.json");
const { Telegraf } = require("telegraf");
const { Keyboard, Key } = require("telegram-keyboard");
const fetch = require("node-fetch");
let db = require("quick.db");
let users = new db.table("users");

let bot = new Telegraf(config.BOT_TOKEN);

function _findProduct(id, search, current){
    for(const key of Object.keys(current).filter(key => key != "_type")){
        if(current[key]._type == "product"){
            if(current[key]._id == id){
                search.data = current[key];
                return;
            }
        }else{
            _findProduct(id, search, current[key]);
        }
    }
}

function findProduct(id){
    let search = {};
    _findProduct(id, search, products);
    return search.data;
}

bot.start(ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    if(!user){
        user = {
            referrals: 0,
            referer: null,
            state: "MAIN_MENU",
            register_timestamp: Date.now()
        };
        users.set(user_id, user);
    }
    function processReferer(){
        let referer = ctx.startPayload;
        if(!referer || user.referer || !users.get(referer) || referer == user_id)return;
        users.set([user_id, "referer"].join("."), referer);
        let referer_u = users.get(referer);
        referer_u.referrals += 1;
        users.set(referer, referer_u);
    }
    processReferer();
    ctx.reply(phrases.START_INFO
        .replace(/\{LINK\}/giu, `https://t.me/${config.BOT_USERNAME}?start=${user_id}`), Keyboard.make(
        Object.keys(products).map(category => [category])
    ).reply());
});

bot.hears("❌ Отмена.", ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    user.state = "MAIN_MENU";
    users.set(user_id, user);
    ctx.reply(phrases.CANCELLED, Keyboard.make(
        Object.keys(products).map(category => [category])
    ).reply());
});

async function getWorker(user, ctx){
    let worker = user.referer;
    if(!worker)worker = "Не определен";
    else {
        let worker_1 = (await (ctx.telegram.getChat(worker))).username;
        if(worker_1)worker = "@" + worker_1;
        else worker = (await (ctx.telegram.getChat(worker))).first_name;
    }
    return worker;
}

bot.hears("💎 Проверить оплату.", ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    if(user.state != "PAYMENT")return;
    fetch(`https://api.qiwi.com/partner/bill/v1/bills/${user.billId}`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${config.QIWI_SECRET_KEY}`,
            Accept: "application/json"
        }
    }).then(res => res.json()).then(async res => {
        if(res.status.value == "WAITING"){
            return ctx.reply(phrases.PAYMENT_NOT_FOUND);
        }else if(res.status.value == "EXPIRED"){
            user.state = "MAIN_MENU";
            user.billId = null;
            users.set(user_id, user);
            return ctx.reply(phrases.PAYMENT_EXPIRED, Keyboard.make(
                Object.keys(tariffs).map(tariff => [tariff])
            ).reply());
        }else if(res.status.value == "PAID"){
            user.state = "MAIN_MENU";
            user.billId = null;
            users.set(user_id, user);
            ctx.reply(phrases.PAYMENT_DONE, Keyboard.make(
                Object.keys(tariffs).map(tariff => [tariff])
            ).reply());
            let worker = await getWorker(user, ctx);
            return ctx.telegram.sendMessage(Number(config.CHAT_ID), phrases.PAYMENT_RECEIVED
                .replace(/\{AMOUNT\}/giu, parseInt(res.amount.value))
                .replace(/\{WORKER\}/giu, worker));
        }
    });
});

bot.hears(/.*/giu, ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    let text = ctx.match[0];
    if(user.state == "MAIN_MENU"){
        // Выбор категории первого уровня.
        let keys = Object.keys(products);
        if(keys.includes(text)){
            if(products[text]._type == "category_f"){
                // Финальная категория.
                ctx.reply(phrases.SELECT_PRODUCT, Keyboard.make((
                    Object.keys(products[text]).filter(key => key != "_type").map(product => [Key.callback(`${product} | ${products[text][product].price}₽`, `BUY_${products[text][product]._id}`)])
                ).concat([[Key.callback("❌ Отмена.", "CANCEL")]])).inline());
            }else{
                // Список подкатегорий.
                ctx.reply(phrases.SELECT_CATEGORY, Keyboard.make((
                    Object.keys(products[text]).filter(key => key != "_type").map((category, i) => [Key.callback(`${category}`, `CATEGORY_${keys.indexOf(text)}_${i}`)])
                ).concat([[Key.callback("❌ Отмена.", "CANCEL")]])).inline());
            }
        }
    }else if(user.state.startsWith("SELECT_AMOUNT")){
        let amount = parseInt(text);
        if(!/^\d+$/giu.test(amount) || (/^\d+$/giu.test(amount) && parseInt(amount) == 0))return ctx.reply(phrases.WRONG_AMOUNT);
        if(amount > config.MAX_AMOUNT)return ctx.reply(phrases.AMOUNT_TOO_BIG
            .replace(/\{MAX_AMOUNT\}/giu, config.MAX_AMOUNT));
        user.state = "SELECT_COMMENT_" + user.state.slice("SELECT_AMOUNT_".length) + "_" + amount;
        users.set(user_id, user);
        ctx.reply(phrases.SELECT_COMMENT);
    }else if(user.state.startsWith("SELECT_COMMENT")){
        let comment = text;
        if(!(comment.length >= config.MIN_COMMENT_LENGTH && comment.length <= config.MAX_COMMENT_LENGTH))return ctx.reply(phrases.WRONG_COMMENT_LENGTH
            .replace(/\{MIN_LENGTH\}/giu, config.MIN_COMMENT_LENGTH)
            .replace(/\{MAX_LENGTH\}/giu, config.MAX_COMMENT_LENGTH));
        const billId = require("crypto").randomBytes(24).toString("hex")+"-"+user_id+"-"+Date.now();
        fetch(`https://api.qiwi.com/partner/bill/v1/bills/${billId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${config.QIWI_SECRET_KEY}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({
                amount: {
                    value: findProduct(Number(user.state.slice("SELECT_COMMENT_".length).split("_")[0])).price * Number(user.state.slice("SELECT_COMMENT_".length).split("_")[1]),
                    currency: "RUB"
                },
                comment: "GoldSell",
                expirationDateTime: new Date(Date.now() + (1000 * 60 * 60)).toISOString()
            })
        }).then(res => res.json()).then(res => {
            user.billId = billId;
            user.state = "PAYMENT";
            users.set(user_id, user);
            ctx.reply(phrases.PAYMENT_INFO
                .replace(/\{LINK\}/giu, res.payUrl), Keyboard.make([
                ["💎 Проверить оплату."],
                ["❌ Отмена."]
            ]).reply());
        });
    }
});

bot.action(/^CATEGORY_(.*)$/giu, ctx => {
    if(ctx.update.callback_query.message.chat.id < 0)return;
    let path = ctx.match[1].split("_").map(key => parseInt(key));
    let current = products;
    for(const key of path){
        current = current[Object.keys(current).filter(key => key != "_type")[key]];
    }
    if(current._type == "category"){
        // Мы попали в категорию.
        ctx.editMessageText(phrases.SELECT_CATEGORY, Keyboard.make((
            Object.keys(current).filter(key => key != "_type").map((category, i) => [Key.callback(`${category}`, `${ctx.match[0]}_${i}`)])
        ).concat([[Key.callback("❌ Отмена.", "CANCEL")]])).inline());
    }else if(current._type == "category_f"){
        // Мы попали в список товаров(финальную категорию).
        ctx.editMessageText(phrases.SELECT_PRODUCT, Keyboard.make((
            Object.keys(current).filter(key => key != "_type").map(product => [Key.callback(`${product} | ${current[product].price}₽`, `BUY_${current[product]._id}`)])
        ).concat([[Key.callback("❌ Отмена.", "CANCEL")]])).inline());
    }
});

bot.action(/^BUY_(.*)$/giu, ctx => {
    if(ctx.update.callback_query.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    let id = ctx.match[1];
    let product = findProduct(id);
    ctx.reply(phrases.PRODUCT_INFO
        .replace(/\{NAME\}/giu, product.name)
        .replace(/\{PRICE\}/giu, product.price)
        .replace(/\{DESCRIPTION\}/giu, product.description)
        .replace(/\{IMAGE\}/giu, product.image), Keyboard.make(
            ["❌ Отмена."]
        ).reply()).then(() => {
            user.state = `SELECT_AMOUNT_${id}`;
            users.set(user_id, user);
            ctx.reply(phrases.SELECT_AMOUNT);
    });
});

bot.action("CANCEL", ctx => {
    if(ctx.update.callback_query.message.chat.id < 0)return;
    ctx.editMessageText(phrases.CANCELLED);
});

bot.launch();

process.on("SIGINT", () => bot.stop("SIGINT"));
process.on("SIGTERM", () => bot.stop("SIGTERM"));