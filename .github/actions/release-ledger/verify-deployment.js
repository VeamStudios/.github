const SHA=/^[a-f0-9]{40}$/;
async function verifyDeployment(url,commit,repository,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))) {
  const endpoint=new URL(url);
  if(endpoint.protocol!=='https:'||!SHA.test(commit))throw new Error('Production verification requires HTTPS and an exact commit');
  let error;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetchImpl(endpoint,{redirect:'error',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`Production verification returned HTTP ${response.status}`);
      const body=await response.json();
      if(!SHA.test(body.commit)||body.commit!==commit)throw new Error('Production endpoint does not report the shipped commit');
      if(body.repository!==repository)throw new Error('Production endpoint belongs to another repository');
      return {kind:'http',evidence:endpoint.href,checkedAt:new Date().toISOString(),commit,reportedCommit:body.commit,repository:body.repository};
    } catch(e){error=e;if(attempt<2)await sleep(1000*(attempt+1))}
  }
  throw error;
}
module.exports={verifyDeployment};
