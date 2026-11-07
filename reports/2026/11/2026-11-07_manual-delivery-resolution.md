# 未投稿11件の手動処理済み記録

2026-11-07、運用者の指示により、旧Bufferチャンネルで失敗した以下の11件は再送を見送りました。

実際の送信成功を示す記録ではありません。既存実装の終端状態である `sent` を、再送・履歴照合の対象から外すために campaign.postStatus と delivery.status の両方へ設定しました。実投稿日時（postedAt）は追加していません。最後のエラーは状態ファイルから除き、元の失敗内容は過去の実行レポートへ保持しています。旧Buffer投稿ID・本文・試行回数・発見履歴・その他の送信済み記録は変更していません。

対象の実行: https://github.com/tomlle/morotoko/actions/runs/42373330678

| Campaign ID | ゲーム | 旧Buffer投稿ID |
| --- | --- | --- |
| steam:4921720:permanent_free:1 | 47都道府県にプロ野球チームが存在する世界線で日本一の球団をめざそう！ | 6aed975a86fe9b837985328c |
| steam:5433020:permanent_free:1 | Hide IN SPACE | 6aed975c7b7e47e8f41c8c6f |
| steam:4766670:permanent_free:1 | 幻兽纪元 | 6aed975d07f945cca951e044 |
| steam:5219930:permanent_free:1 | Wild Ones Evolution | 6aed975f07f945cca951e2cb |
| steam:5229130:permanent_free:1 | Late Night with Ken Hayes | 6aed9760c1e74b84e5db2af5 |
| steam:5462800:permanent_free:1 | Massive Army Battle | 6aed9761c1e74b84e5db2ba1 |
| steam:5446410:permanent_free:1 | Tikra Rida | 6aedc18e64d4343f608cec0d |
| steam:4890840:permanent_free:1 | IVAN (Iter Vehemens ad Necem) | 6aedc18f64d4343f608ced2d |
| steam:5486310:permanent_free:1 | Forbidden House | 6aedc19136c33a13362837ff |
| steam:5349900:permanent_free:1 | Mystic Fog Maze | 6aedc193c60945d644996651 |
| steam:4864070:permanent_free:1 | 萌爪造万物 | 6aedc1941fcdcefa468a2f0a |
