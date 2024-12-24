import EmojiConvertor from 'emoji-js';
const emoji = new EmojiConvertor();
emoji.replace_mode = 'unified';

function parseMessageContent(content: string) {
    // Replace Unicode emojis with :name: textual representations
    emoji.colons_mode = true;
    content = emoji.replace_unified(content);

    // Replace regional indicator emojis with textual representations
    content = content.replace(/\ud83c[\udde6-\uddff]/g, match => {
        return ":regional_indicator_"
            + String.fromCharCode(match.charCodeAt(1) - 0xdde6 + 97)
            + ":";
    })
    return content;
}

export default function parseMessageObject(msg: any) {
    const result: any = {
        id: msg.id,
        channel_id: msg.channel_id
    }
    if (msg.author) {
        result.author = {
            id: msg.author.id,
            avatar: msg.author.avatar,
            global_name: msg.author.global_name
        }
        if (msg.author.global_name == null) {
            result.author.username = msg.author.username;
        }
    }
    if (msg.type >= 1 && msg.type <= 11) result.type = msg.type;

    // Parse content 
    if (msg.content) {
        result.content = parseMessageContent(msg.content);
        if (result.content != msg.content) result._rc = msg.content;
    }

    if (msg.referenced_message) {
        let content = parseMessageContent(msg.referenced_message.content);

        // Replace newlines with spaces (reply is shown as one line)
        content = content.replace(/\r\n|\r|\n/gm, "  ");

        if (content && content.length > 50) {
            content = content.slice(0, 47).trim() + '...';
        }
        result.referenced_message = {
            author: {
                global_name: msg.referenced_message.author.global_name,
                id: msg.referenced_message.author.id,
                avatar: msg.referenced_message.author.avatar
            },
            content
        }
        if (msg.referenced_message.author.global_name == null) {
            result.referenced_message.author.username =
                msg.referenced_message.author.username;
        }
    }

    if (msg.attachments?.length) {
        result.attachments = msg.attachments
            .map(att => {
                return {
                    filename: att.filename,
                    size: att.size,
                    width: att.width,
                    height: att.height,
                    proxy_url: att.proxy_url
                };
            })
    }
    if (msg.sticker_items?.length) {
        result.sticker_items = [{name: msg.sticker_items[0].name}];
    }
    if (msg.embeds?.length) {
        result.embeds = msg.embeds.map(emb => {
            return {
                title: emb.title,
                description: emb.description
            };
        })
    }

    // Need first mentioned user for group DM join/leave notification messages
    if ((msg.type == 1 || msg.type == 2) && msg.mentions.length) {
        result.mentions = [
            {
                id: msg.mentions[0].id,
                global_name: msg.mentions[0].global_name
            }
        ]
        if (msg.mentions[0].global_name == null) {
            result.mentions[0].username = msg.mentions[0].username;
        }
    }

    return result;
}