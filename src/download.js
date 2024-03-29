import * as FS from "./fs.js";

function num2Str( fig, num ) {
    return num.toString(10).padStart( fig, '0' );
}

function joinUrl( srcURL, url ) {
    if ( url.startsWith( "http://" ) ||
         url.startsWith( "https://" ) ) {
        // FQDN 指定
    } else if ( url.startsWith( "/" ) ) {
        // 絶対パス指定
        url = srcURL.protocol + "//" + srcURL.host + url;
    } else {
        // 相対パス指定
        let parent = srcURL.pathname.replace( /[^/]+$/, "" );
        url = srcURL.protocol + "//" + srcURL.host + parent + url;
    }
    return url;
}

async function retryDownload( url, retryCount ) {
    let response;
    let count = 0;

    while ( count <= retryCount ) {
        try {
            response = await fetch(url);
        } catch (error) {
            console.error('error:', error);
            throw error;
        }

        if (response.status === 404) {
            throw new Error( "not found -- " + url );
        }

        if (response.ok) {
            return response;
        }
        count++;
    }
    throw new Error( "retry over -- " + url );
}


function downloadFromList( max, list, progressFunc ) {

    let promise = new Promise( (resolve, reject)=>{
        let url2blob = new Map();
        // エラーのリトライ回数
        const maxRetry = 3;

        // 平行処理中の数
        let count = 0;

        const remain = list.slice();


        function reqNext() {
            if ( remain.length > 0 ) {
                count++;
                req( remain.shift(), 0 );
            }
        }
        
        function req( url, retryCount ) {
            if ( retryCount < maxRetry ) {
                retryCount++;
                fetch( url ).then((resp)=>{
                    if ( resp.status != 200 ) {
                        console.log( `retry -- ${retryCount}:${url}` );
                        req( url, retryCount );
                    } else {
                        onDownload( url, resp );
                    }
                });
            } else {
                reject( `over retry -- ${url}` );
            }
        }

        let progress = 0;
        function onDownload( url, resp ) {
            resp.blob().then( (blob)=>{
                count--;
                reqNext();
                progress++;
                url2blob.set( url, blob );

                if ( !progressFunc( url2blob ) ) {
                    resolve( false );
                } else {
                    if ( progress == list.length ) {
                        resolve( true );
                    }
                }
            });
        }

        while ( remain.length > 0 && count < max ) {
            reqNext();
        }
    });
    return promise;
}


async function downloadAndJoin( urlList, progressFunc ) {
    let date_txt;    

    {
        let now = new Date();
        date_txt = `${now.getFullYear()}-` +
            `${num2Str( 2, now.getMonth() + 1 )}-` +
            `${num2Str( 2, now.getDate() )}_` +
            `${num2Str( 2, now.getHours() )}-` +
            `${num2Str( 2, now.getMinutes() )}-` +
            `${num2Str( 2, now.getSeconds() )}.` +
            `${num2Str( 3, now.getMilliseconds() )}`;
    }
    console.log( date_txt );
    


    function saveAs( name, blob ) {
        let workUrl = URL.createObjectURL( blob );

        const anchor = document.createElement("a");
        anchor.href = workUrl;
        anchor.download = name;
        anchor.click();
        
        //URL.revokeObjectURL( workUrl );
    }

    const ext = ".bin";


    const dirObj = await FS.createDir( "downloads" );
    const fileObj = await dirObj.createFile( `${date_txt}${ext}` );
    const writer = await fileObj.getWritable();


    let cancelFlag = false;

    const max_div_el = document.getElementById( "max_div" );
    const max_div = parseInt( max_div_el.value );


    let index = 0;
    let count = 0;
    cancelFlag = ! (await downloadFromList( max_div, urlList, (url2blob)=>{
        count++;
        if ( !progressFunc( count ) ) {
            return false;
        }

        while ( index < urlList.length ) {
            let url = urlList[ index ];
            if ( url2blob.has( url ) ) {
                index++;
                writer.write( url2blob.get( url ) );
            } else {
                break;
            }
        }
        return true;
    }));
    
    await writer.close();
    
    if ( !cancelFlag ) {
        let blob = await fileObj.getBlob();
        saveAs( `${date_txt}${ext}`, blob );
    }
}

async function downloadFromHlsStream( title, url ) {
    console.log( "downloadFromHlsStream", title, url );

    let srcURL = new URL( url );

    let resp = await fetch( url );
    let m3u = await resp.text();

    const urlList = [];
    let hasHeader = false;
    m3u.split( "\n" ).forEach( (line)=>{
        if ( hasHeader ) {
            urlList.push( joinUrl( srcURL, line ) );
            hasHeader = false;
        } else if ( line.startsWith( "#EXTINF:" ) ) {
            hasHeader = true;
        }
    });

    const div_el = document.getElementById( "progress" );

    const dummy_el = document.createElement( "div" );
    div_el.append( dummy_el );
    dummy_el.innerHTML = `
<input type="button" value="cancel" >
<div>${title}</div>
<progress style="width:100%;" max="${urlList.length}" value="0">
`;

    let cancelFlag = false;
    dummy_el.querySelector( "input" ).addEventListener(
        "click",
        ()=>{ cancelFlag = true; } );

    await downloadAndJoin(
        urlList,
        (progress)=>{
            dummy_el.querySelector( "progress" ).value = progress;
            return !cancelFlag;
        });

    dummy_el.remove();
}


function analyzeHls( m3u, url ) {
    // 各 url → それぞれのコーデックの詳細マップの作成
    const url2detail = {};
    let srcURL = new URL( url );

    let detail = null;
    m3u.split( "\n" ).forEach( (line)=>{
        if ( detail == null ) {
            if ( line.startsWith( "#EXT-X-STREAM-INF:" ) ) {
                detail = line.replace( "#EXT-X-STREAM-INF:", "" );
            }
        } else {
            let stream_url = joinUrl( srcURL, line );
            url2detail[ stream_url ] = detail;
            detail = null;
        }
    });
    return url2detail;
}

export async function downloadFromHls( title, url ) {
    const resp = await fetch( url );
    const m3u = await resp.text();

    const list_el = document.querySelector( "#stream-list" );
    const selector_el = document.querySelector( ".stream-selector" );

    const url2detail = analyzeHls( m3u, url );

    // どの URL を処理するかユーザ選択
    if ( Object.keys( url2detail ).length != 0 ) {
        while ( list_el.firstChild ) {
            list_el.removeChild( list_el.firstChild );
        }
        Object.keys( url2detail ).forEach( (stream_url)=>{
            let detail = url2detail[ stream_url ];
            let dummy_el = document.createElement( "div" );
            dummy_el.innerHTML = `
<div class="stream-item">
<input type="button" value="download">
<div>${detail}</div>
</div>
`;
            let item_el = dummy_el.querySelector( ".stream-item" );
            item_el.querySelector( "input" ).addEventListener(
                "click",
                async ()=>{
                    selector_el.hidden = true;
                    await downloadFromHlsStream( title, stream_url );
                });
            list_el.append( item_el );
        });

        selector_el.querySelector( "input" ).addEventListener(
            "click",
            ()=>{ selector_el.hidden = true; } );
        
        selector_el.hidden = false;
    } else {
        await downloadFromHlsStream( title, url );
    }
}
