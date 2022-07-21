import express from 'express'
import axios from 'axios'
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
import bodyParser from 'body-parser'
const { createHash, createHmac } = await import('node:crypto')
import { fileTypeFromBuffer } from 'file-type'

/**
 * @summary set up express and globals
 * @requires port :: port to listen on
 * @requires TOKEN :: Trello Token
 * @requires KEY :: Trello API Key
 * @requires SECRET :: Trello API Secret
 * @requires USERS :: JSON of Trello Names and their corresponding discord ID
 * @requires HOOKS :: JSON of Trello Board IDs and their correspondiong discord webhook
 */

const router = express.Router()
const app = express()
const port = 4500
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
app.use(express.static('public'))

const TOKEN = process.env.API_TOKEN
const KEY = process.env.API_KEY
const SECRET = process.env.API_SECRET
const USERS = JSON.parse(process.env.USERS)
const HOOKS = JSON.parse(process.env.HOOKS)

/**
 * @summary set up trello header checking
 * @param {*} s
 * @returns HASH to compare Trello post headers
 */
const base64Digest = s => {
	return createHmac('sha1', SECRET).update(s).digest('base64')
}

/**
 * @summary set up database
 */
const SUPERBASE = createClient(process.env.DATABASE, process.env.SB_PUBLIC_KEY)

/**
 * TODO Look at these being set here ...
 */

/**
 * @summary used when registering new Trello webhooks
 */

// router.get('/', async (req, res) => {
// 	res.send('Hi')
// 	const post = await axios.post(
// 		`https://api.trello.com/1/tokens/${TOKEN}/webhooks/?key=${KEY}`,
// 		{
// 			description: 'Public Graphics Webhook',
// 			callbackURL: 'process.env.END_POINT',
// 			idModel: 'board id',
// 		}
// 	)
// })

// router.head('/api', (req, res) => {
// 	res.status(200).send('ok')
// })

/**
 * @summary :: POST endpoint
 * @summary :: ONLY accepts calls from Trello POSTS
 */

router.post(`/api`, async (req, res) => {
	let mentionContent = null
	//----- CHECK THE POST IS FROM TRELLO
	const CONTENT = JSON.stringify(req.body) + process.env.END_POINT
	const DOUBLE_HASH = base64Digest(CONTENT)
	const HEADER_HASH = req.headers['x-trello-webhook']

	if (DOUBLE_HASH != HEADER_HASH) {
		res.status(401).send('Unauthorized')
		return false
	}

	//----- ONLY PROCESS ACTIONS WE WANT
	const ALLOWED_ACTIONS = [
		'action_comment_on_card',
		'action_add_attachment_to_card',
		'action_create_card',
		'action_move_card_from_list_to_list',
		'action_add_label_to_card',
		'action_archived_card',
	]

	//-----  DECONSTRUCT THE POST DATA
	/**
	 * @param :: ACTION :: the incoming Trello action
	 * @param :: LIST_NAME :: Trello list name
	 * @param :: CARD_NAME :: Card name
	 * @param :: CARD_URL :: Short URL to card
	 * @param :: CARD_ID :: Card's ID
	 * @param :: ATTACHMENT_ID
	 * @param :: ATTACHMENT_NAME
	 * @param :: ATTACHMENT_URL
	 * @param :: OLD_LIST :: List card was moved FROM
	 * @param :: NEW_LIST :: List card was moved TO
	 * @param :: TEXT :: Can be message Text OR lable name
	 * @param :: DATA_VALUE :: Color of label
	 * @param :: USER_AVATAR_URL
	 * @param :: FULL_NAME :: User's Name on Trello
	 * @param :: TIMESTAMP
	 * @param :: BOARD_URL
	 * @param :: BOARD_NAME
	 * @param :: BOARD_ID
	 */
	const {
		body: {
			action: {
				display: { translationKey: ACTION },
				data: {
					list: { name: LIST_NAME } = { name: null },
					card: {
						name: CARD_NAME,
						shortLink: CARD_URL,
						id: CARD_ID,
					} = { name: null },
					attachment: {
						id: ATTACHMENT_ID,
						name: ATTACHMENT_NAME,
						previewUrl: ATTACHMENT_URL,
					} = { id: null, name: null, previewUrl: null },
					listBefore: { name: OLD_LIST } = { name: null },
					listAfter: { name: NEW_LIST } = { name: null },
					text: TEXT,
					value: DATA_VALUE,
				},
				memberCreator: {
					avatarUrl: USER_AVATAR_URL,
					fullName: FULL_NAME,
				},
				date: TIMESTAMP,
			},
			model: { shortUrl: BOARD_URL, name: BOARD_NAME, id: BOARD_ID },
		},
	} = req

	//----- Reject if its a differnt action than we want
	if (!ALLOWED_ACTIONS.includes(ACTION)) {
		res.status(200).send('Wrong Action Type')
		return false
	}

	//----- only want a few actions for the KTO graphics board
	if (
		BOARD_ID === '62d5f89049b4ce140f831fec' &&
		ACTION != 'action_add_label_to_card' &&
		ACTION != 'action_archived_card'
	) {
		res.status(200).send('Wrong Action Type')
		return false
	}
	console.log(ACTION)

	//----- Set some default discord message values
	const LIST_DISPLAY = LIST_NAME ? LIST_NAME : NEW_LIST
	const FIELDS = {
		author: {
			name: `Trello :: ${BOARD_NAME}`,
		},
		thumbnail: {
			url: `${USER_AVATAR_URL}/60.png`,
		},
		timestamp: TIMESTAMP,
		footer: {
			text: '♥ Nahana',
		},
		fields: [
			{
				name: 'List',
				value: `[${LIST_DISPLAY}](${BOARD_URL})`,
			},
			{
				name: 'Card',
				value: `[${CARD_NAME}](https://trello.com/c/${CARD_URL})`,
			},
		],
	}

	//----- Check if theres a cover image
	const COVER_RES = await axios.get(
		`https://api.trello.com/1/cards/${CARD_ID}?key=${KEY}&token=${TOKEN}`
	)

	//----- If there's a cover we'll use that as the thumb instead of the user avatar
	if (COVER_RES.data.cover.scaled) {
		let cover = await getRemoteImage(
			COVER_RES.data.cover.scaled[2].url,
			`${CARD_ID}_cover_thumb`
		)

		if (cover) {
			FIELDS.thumbnail = {
				url: `https://trello.nahana.net/img/${cover}`,
			}
		}
	}

	/**
	 *
	 * @param {*} action
	 * @summary :: runs different action depending on the incoing Trello action
	 * @case :: action_comment_on_card :: sends a Trello comment. Will replace mentioned Trello userse with their discord name and tag them
	 * @case :: action_add_attachment_to_card :: sends when an image is added to a card
	 * @case :: action_create_card :: new card added message
	 * @case :: action_move_card_from_list_to_list :: when a card is moved
	 * @case :: action_add_label_to_card :: lable added. Also handels sending to graphics channel
	 */
	const tryAction = async action => {
		switch (action) {
			default:
				throw 'Wrong Action'
				break

			//----- new comment
			case 'action_comment_on_card':
				FIELDS.title = `New Comment By ${FULL_NAME}`

				//----- repalce @ trello with <@> discord
				let originalMessage = TEXT

				let message = Object.entries(USERS).reduce(
					(f, s) =>
						`${f}`.replace(
							new RegExp(`@${s[0]}`, 'g'),
							`<@${s[1]}>`
						),
					originalMessage
				)

				//----- also mention them outside the embed since embed @s won't ping
				let mentions = Object.entries(USERS)
					.filter(([k, v]) => {
						let user = k
						if (originalMessage.includes(k)) {
							return v
						}
					})
					.map(obj => {
						return `<@${obj[1]}>`
					})

				if (mentions) {
					mentionContent = mentions.join(' ')
				}

				FIELDS.description = message
				break

			//----- new image added
			case 'action_add_attachment_to_card':
				FIELDS.title = `New Image Added`
				let name = ATTACHMENT_NAME
				let url = ATTACHMENT_URL

				//----- get the remove image and save locally to send
				let image = await getRemoteImage(
					`https://api.trello.com/1/cards/${CARD_ID}/attachments/${ATTACHMENT_ID}/previews/preview/download/${name}`,
					name
				)

				if (image) {
					FIELDS.image = {
						url: `https://trello.nahana.net/img/${image}`,
					}
				}

				break
			//----- new card
			case 'action_create_card':
				FIELDS.title = `New Card Added By ${FULL_NAME}`
				break
			//----- moved to list
			case 'action_move_card_from_list_to_list':
				FIELDS.title = `Card Moved to ${NEW_LIST}`
				FIELDS.fields = FIELDS.fields.filter(
					item => item.name != 'List'
				)
				FIELDS.description = `[${CARD_NAME}](https://trello.com/c/${CARD_URL}) has been moved from **${OLD_LIST}** to **${NEW_LIST}**`

				break
			//----- add lable
			case 'action_add_label_to_card':
				//----- the default (all boards but KTO Graphics)
				if (BOARD_ID != '62d5f89049b4ce140f831fec') {
					FIELDS.title = `Label Added To ${CARD_NAME}`
					FIELDS.fields = FIELDS.fields.filter(
						item => item.name != 'List'
					)
					FIELDS.description = `The label **${TEXT}** has been added to **[${CARD_NAME}](https://trello.com/c/${CARD_URL})**`
				}
				//----- If its the KTO graphics borad the message will be different and will send to a different server
				if (
					BOARD_ID === '62d5f89049b4ce140f831fec' &&
					DATA_VALUE === 'green' &&
					TEXT === 'Sent'
				) {
					let response = await axios.get(
						`https://api.trello.com/1/cards/${CARD_ID}/attachments?key=${KEY}&token=${TOKEN}`
					)
					if (response.data[0].url) {
						FIELDS.image = {
							url: response.data[0].url,
						}
					}
					FIELDS.author = {
						name: null,
					}
					FIELDS.title = `New KTO Graphic!`
					FIELDS.thumbnail = {
						url: null,
					}
					FIELDS.fields = null
					FIELDS.description = `**[Download Graphic](${response.data[0].url})**\n\n[View All Grapics](https://trello.com/b/krXSdDI3/kto-graphics)`
				}
				break
			case 'action_archived_card':
				if (BOARD_ID != '62d5f89049b4ce140f831fec') {
					throw 'Wrong Action'
				}
				const { data, error } = await SUPERBASE.from('gfx_message')
					.select('graphicID, messageID')
					.eq('graphicID', CARD_ID)

				for (const item of data) {
					let del = await axios.delete(
						`https://discord.com/api/webhooks/${process.env.KHOOK_ID}/${process.env.KHOOK_TOKEN}/messages/${item.messageID}`
					)
				}
				throw 'No message needed'

				break
		}
	}

	//----- run the incoming action

	try {
		await tryAction(ACTION)
	} catch (e) {
		res.status(200).send('Wrong Action Type')
		return false
	}

	//----- set discord payload
	const PAYLOAD = {
		embeds: [FIELDS],
		content: mentionContent,
	}

	//----- send to discord
	let endPoint = Object.values(HOOKS).find(ele => ele.trelloId === BOARD_ID)
	let post = await axios.post(`${endPoint.hook}?wait=true`, PAYLOAD)

	//----- Store the card and webhook message ID
	//----- Needed so if the graphic card is removed, the message will also be removed
	if (BOARD_ID === '62d5f89049b4ce140f831fec') {
		const { data, error } = await SUPERBASE.from('gfx_message').insert([
			{ graphicID: CARD_ID, messageID: post.data.id },
		])
	}

	//----- CLEAR INFO
	Object.keys(FIELDS).forEach(key => delete FIELDS[key])
	mentionContent = null
	res.status(200).send('OK')
})

app.use('/', router)

app.listen(port, () => {
	console.log(`listening on port ${port}`)
})

// ===== REUSABLE FUNCTION FOR GETTING IMAGES OFF TRELLO
const getRemoteImage = async (url, filename) => {
	let response = await axios.get(url, {
		headers: {
			Authorization: `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`,
		},
		responseType: 'arraybuffer',
	})

	let buffer = Buffer.from(response.data, 'binary')
	let type = await fileTypeFromBuffer(buffer)

	return new Promise((resolve, reject) => {
		if (type.mime.match('image')) {
			buffer = buffer.toString('base64')
			filename = filename.replace(/\.[^/.]+$/, '')
			filename =
				filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() +
				`.${type.ext}`
			fs.writeFileSync(`public/img/${filename}`, buffer, 'base64')
			resolve(filename)
		} else {
			reject(false)
		}
	})
}
