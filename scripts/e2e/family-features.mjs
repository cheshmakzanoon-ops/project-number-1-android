import assert from 'node:assert/strict';

async function lobby(page) {
  const back=page.getByRole('button',{name:'بازگشت',exact:true});
  if(await back.count()) await back.click();
  await page.getByRole('button',{name:'گفتگوها',exact:true}).click();
  await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().waitFor();
}
async function group(page,names) {
  await lobby(page);
  await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().click();
  await page.getByRole('button',{name:'گروه',exact:true}).click();
  for(const name of names) await page.getByText(name,{exact:true}).last().click();
  await page.getByRole('button',{name:/^ساخت گروه با/}).click();
  await page.getByRole('button',{name:'تماس تصویری گروهی',exact:true}).waitFor();
}

export async function messagingFeatures({child,dad,context,register,send,check,until}) {
  // These accounts and data belong only to the disposable messaging backend.
  await check('Search results open the actual matching message',async()=>{
    await lobby(child);
    await child.getByText('CI queued offline',{exact:true}).click();
    await child.getByRole('button',{name:'جستجو در گفتگو',exact:true}).click();
    await child.getByPlaceholder('جستجو در گفتگو…').fill('CI hello from dad');
    await child.getByRole('button').filter({hasText:'CI hello from dad'}).click();
    await child.locator('[data-mid] p.whitespace-pre-wrap').filter({hasText:/^CI hello from dad$/}).waitFor();
    await child.getByRole('button',{name:/نمایش اطراف پیام/}).click();
  });
  await check('Conversation mute state can be enabled and disabled',async()=>{
    await child.getByRole('button',{name:'بی‌صدا کردن',exact:true}).click();
    await child.getByRole('button',{name:'لغو بی‌صدا',exact:true}).click();
    await child.getByRole('button',{name:'بی‌صدا کردن',exact:true}).waitFor();
  });
  await check('Uploaded image opens in the full-screen viewer and closes without message actions',async()=>{
    await dad.getByRole('button',{name:'باز کردن تصویر',exact:true}).first().click();
    const dialog=dad.getByRole('dialog');await dialog.waitFor();
    assert.ok(await dialog.locator('img').evaluate(image=>image.complete&&image.naturalWidth===12));
    await dialog.getByRole('button',{name:'بستن',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await dad.getByRole('button',{name:'ویرایش',exact:true}).count(),0);
  });
  const third=await context();await register(third,'CI Third');
  await check('A three-person group distributes messages to both other members',async()=>{
    await lobby(dad);
    await group(child,['CI Dad','CI Third']);await send(child,'CI group message');
    for(const page of [dad,third]) {
      await page.getByText('CI group message',{exact:true}).click();
      await page.getByRole('button',{name:'تماس صوتی گروهی',exact:true}).waitFor();
      await page.locator('[data-mid] p.whitespace-pre-wrap').filter({hasText:/^CI group message$/}).waitFor();
    }
    await send(third,'CI reply to group');
    for(const page of [child,dad]) await page.getByText('CI reply to group',{exact:true}).waitFor();
  });
  await check('Creating the same group from another member preserves the existing conversation',async()=>{
    await group(third,['CI Child','CI Dad']);
    await third.getByText('CI group message',{exact:true}).waitFor();
    await third.getByText('CI reply to group',{exact:true}).waitFor();
  });
  await check('Text statuses publish, record the real viewer, and can be deleted',async()=>{
    for(const page of [child,dad]) {await lobby(page);await page.getByRole('button',{name:'وضعیت‌ها',exact:true}).click();}
    await child.getByRole('button',{name:'وضعیت جدید',exact:true}).click();
    await child.getByPlaceholder('حال و روزت را بنویس…').fill('CI family status');
    await child.getByRole('button',{name:'ثبت وضعیت',exact:true}).click();
    await dad.getByRole('button',{name:'وضعیت CI Child',exact:true}).click();
    await dad.getByText('CI family status',{exact:true}).last().waitFor();
    await dad.getByRole('button',{name:'بستن',exact:true}).last().click();
    await child.getByRole('button',{name:'وضعیت CI Child',exact:true}).click();
    await child.getByRole('button',{name:'دیدن لیست',exact:true}).click();
    await child.getByText('CI Dad',{exact:true}).waitFor();
    await child.getByRole('button',{name:'حذف وضعیت',exact:true}).click();
    await dad.getByRole('button',{name:'وضعیت CI Child',exact:true}).waitFor({state:'hidden'});
  });
  await check('Image statuses retain an editable caption and display decoded pixels to the family',async()=>{
    await child.getByRole('button',{name:'وضعیت جدید',exact:true}).click();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVR4nGPUTdvDQAgwEVQxqmgAFAEAWIEBZ+DAdM0AAAAASUVORK5CYII=','base64');
    await child.locator('input[type=file]').setInputFiles({name:'status.png',mimeType:'image/png',buffer:png});
    await child.getByPlaceholder('توضیح عکس (اختیاری)…').fill('CI image status caption');
    await child.getByRole('button',{name:'ثبت وضعیت',exact:true}).click();
    await dad.getByRole('button',{name:'وضعیت CI Child',exact:true}).click();
    await dad.getByText('CI image status caption',{exact:true}).last().waitFor();
    await until(()=>dad.locator('img').evaluateAll(images=>images.some(image=>image.complete&&image.naturalWidth===12&&image.naturalHeight===12)),'decoded status image');
    await dad.getByRole('button',{name:'بستن',exact:true}).last().click();
    await child.getByRole('button',{name:'وضعیت CI Child',exact:true}).click();
    await child.getByRole('button',{name:'حذف وضعیت',exact:true}).click();
    await dad.getByRole('button',{name:'وضعیت CI Child',exact:true}).waitFor({state:'hidden'});
  });
}

export async function groupCall({first,second,device,check,media,frames,until}) {
  await check('Three-person video calls deliver two remote cameras to every member',async()=>{
    const third=await device('Media Third');
    await lobby(second);
    await group(first,['Media Receiver','Media Third']);
    await first.getByRole('button',{name:'تماس تصویری گروهی',exact:true}).click();
    for(const page of [second,third]) await page.getByRole('button',{name:/^(پاسخ|پیوستن)$/}).click();
    const evidence=[];
    for(const page of [first,second,third]) {
      await until(async()=>{
        const before=await frames(page);await new Promise(r=>setTimeout(r,700));const after=await frames(page);
        return before.length===2&&after.length===2&&before.every((frame,index)=>frame.width>0&&frame.frames>0&&after[index].frames>frame.frames);
      },'two independently advancing remote cameras',45000);
      evidence.push(await media(page));
    }
    // Leaving a group does not terminate the other two members' conversation.
    await first.getByRole('button',{name:'پایان تماس',exact:true}).click();
    await first.getByRole('button',{name:'پایان تماس',exact:true}).waitFor({state:'hidden'});
    await media(second);await media(third);
    await second.getByRole('button',{name:'پایان تماس',exact:true}).click();
    await third.getByRole('button',{name:'پایان تماس',exact:true}).waitFor({state:'hidden'});
    return {participants:3,remoteCamerasPerParticipant:2,evidence};
  });
}
